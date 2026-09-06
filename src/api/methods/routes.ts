/**
 * A site's routes, derived from its record.
 *
 * This is what replaces mesh-api's `mountRest`, and the difference is not style. That function took
 * `expose: ExposeEntry[]` — a list of live `ToolContract` objects — and mounted one express route per
 * contract **at boot**. A fixed route table known at startup cannot express the thing that is now
 * true: *which routes exist depends on which hostname asked.* One site may expose
 * `domains.zone_find` as `public` while another requires `user`, on one release.
 *
 * So a route table is a **derived value, cached with the record it came from**, and building one is a
 * pure function over two inputs that exist in different places:
 *
 * | | holds | owned by |
 * | --- | --- | --- |
 * | `site.mesh` | which contract keys, and the gate on each | the site's owner — a **grant** |
 * | the contract registry | each contract's method, path and schemas | the module that defined it |
 *
 * The api is the only place both halves are in hand, which is also why the **exposure hash** is
 * computed here and nowhere else.
 */

import type { ToolContract, z as Zod } from '@flybyme/mesh';
import type { ExposedContract, MeshDependency } from '../../cdn/schema/site.js';
import { type CallShape, hashShape, schemaOf } from '../schema/descriptor.js';
import type { Gate } from '../schema/expose.js';

type AnyContract = ToolContract<Zod.ZodTypeAny, Zod.ZodTypeAny>;

/** One reachable call: the contract, the gate in front of it, and where it answers. */
export interface Route {
    /** `domain.action`. */
    readonly key: string;
    readonly contract: AnyContract;
    readonly gate: Gate;
    readonly method: string;
    /** The path as the contract declares it, `:param` segments and all. */
    readonly path: string;
}

export interface RouteTable {
    readonly routes: readonly Route[];
    /**
     * A hash of everything reachable, and the gates in front of it.
     *
     * The site's gate hash. Changes when a gate changes or when routes change.
     */
    readonly exposure: string;
    /**
     * A stable shape hash of reachable contracts and their request/response schemas.
     *
     * Site-independent, gate-independent. What actually answers: is this generated client stale?
     */
    readonly shapeHash: string;
    /**
     * What the site named and the registry does not have.
     *
     * **Reported, not thrown.** A site naming one contract that no mounted module provides should
     * serve its other twenty rather than nothing — a typo in one line taking a whole site off the
     * internet is a worse failure than the typo. Every one is logged, and calling it 404s.
     */
    readonly unknown: readonly string[];
}

/** How a contract key is looked up. The broker's registry in production; a Map in a test. */
export type ContractLookup = (key: string) => AnyContract | undefined;

/**
 * Build a site's route table.
 *
 * Deterministic: routes are sorted by key, so the exposure hash depends on **what is exposed and not
 * on the order somebody wrote the list in**. Reordering `mesh` in a site record must not look to a
 * client like the API changed.
 *
 * When `requires` is provided (from a deployed release), only contracts required by the release's
 * composed parts are routed. A contract in `site.mesh` that no composed part provides is an unused
 * grant, not a route.
 */
export function routeTable(
    mesh: readonly MeshDependency[],
    lookup: ContractLookup,
    hash: (value: unknown) => string,
    requires?: readonly string[],
): RouteTable {
    const routes: Route[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    const byRoute = new Map<string, string>();
    const required = requires !== undefined ? new Set(requires) : undefined;

    for (const dependency of mesh) {
        for (const exposed of dependency.contracts) {
            const key = exposed.key;

            // Two entries for one contract means two gates, and the weaker one would win by accident
            // of ordering. The site record's own schema does not prevent it, so this does.
            if (seen.has(key)) continue;
            seen.add(key);

            // A release says what its parts call (requires); a site says what it exposes (mesh).
            // When a release is present, only contracts required by its composed parts are routed.
            if (required !== undefined && !required.has(key)) {
                continue;
            }

            const contract = lookup(key);
            if (contract === undefined) {
                unknown.push(key);
                continue;
            }

            const method = contract.rest.method.toUpperCase();
            const route = `${method} ${contract.rest.path}`;

            // Two contracts claiming one route is a site that would answer one of them by accident of
            // declaration order. Refused for the second, and named, rather than silently shadowed.
            const owner = byRoute.get(route);
            if (owner !== undefined) {
                unknown.push(`${key} (collides with ${owner} at ${route})`);
                continue;
            }
            byRoute.set(route, key);

            routes.push({ key, contract, gate: gateOf(exposed), method, path: contract.rest.path });
        }
    }

    routes.sort((a, b) => a.key.localeCompare(b.key));

    const shapes: CallShape[] = routes.map((route) => ({
        key: route.key,
        method: route.method,
        path: route.path,
        input: schemaOf(route.contract, 'inputSchema'),
        output: schemaOf(route.contract, 'outputSchema'),
        destructive: route.contract.destructive === true,
        stream: route.contract.rest.isStream === true,
    }));

    return {
        routes,
        unknown,
        exposure: hash(routes.map((route) => [
            route.key, route.method, route.path,
            route.gate.kind === 'auth' ? route.gate.level : `permission:${route.gate.permission}`,
        ])),
        shapeHash: hashShape(shapes, hash),
    };
}

/**
 * The gate, from the site's own entry.
 *
 * The site record's union already makes an entry with neither gate — and one with both —
 * unrepresentable, so this is a translation rather than a check.
 */
const gateOf = (exposed: ExposedContract): Gate =>
    'auth' in exposed
        ? { kind: 'auth', level: exposed.auth }
        : { kind: 'permission', permission: exposed.permission };

/**
 * Which route answers a request.
 *
 * A linear scan with per-segment matching rather than a router: a site exposes tens of contracts, not
 * thousands, and a trie would be a dependency and an index to keep in step with a table that is
 * rebuilt whenever its record changes.
 *
 * **Longest literal prefix wins**, so `GET /zones/mine` beats `GET /zones/:id` however the site
 * happened to order them — otherwise a specific route is shadowed by a general one by accident of
 * declaration order, which is the same failure the route-collision check above refuses.
 */
export function matchRoute(
    table: RouteTable,
    method: string,
    path: string,
): { readonly route: Route; readonly params: Readonly<Record<string, string>> } | undefined {
    const wanted = method.toUpperCase();
    const segments = path.split('/').filter((s) => s !== '');

    let best: { route: Route; params: Record<string, string>; literals: number } | undefined;

    for (const route of table.routes) {
        if (route.method !== wanted) continue;

        const pattern = route.path.split('/').filter((s) => s !== '');
        if (pattern.length !== segments.length) continue;

        const params: Record<string, string> = {};
        let literals = 0;
        let matched = true;

        for (const [index, part] of pattern.entries()) {
            const actual = segments[index]!;
            if (part.startsWith(':')) {
                params[part.slice(1)] = decodeURIComponent(actual);
                continue;
            }
            if (part !== actual) { matched = false; break; }
            literals += 1;
        }

        if (!matched) continue;
        if (best === undefined || literals > best.literals) best = { route, params, literals };
    }

    return best === undefined ? undefined : { route: best.route, params: best.params };
}
