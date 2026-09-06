/**
 * The exposure descriptor: the site's exposure, as data.
 *
 * mesh-web roadmap C3.2 decided the site's repository is the source of truth for what it exposes and
 * the API's collection is a resolved cache. This file is what turns the site's `ExposeEntry[]` —
 * TypeScript, holding live zod schemas and imported at boot — into something a *build* can read:
 * plain JSON, no zod, no imports, no running cluster.
 *
 * That distinction is the whole point. The generated browser client is produced from this
 * (mesh-web spec/network.md §4), so it must be derivable without starting anything. A generator that
 * needed a live API could not run in CI before the API was deployed, which is exactly when you want
 * to know the client is wrong.
 *
 * **Structural, not referential.** Input and output are emitted as JSON Schema rather than as a
 * reference to the zod object that produced them — mesh-web spec/network.md §3.1, and surfdns #15,
 * where a `z.infer` reaching across a package boundary broke on a version bump. A descriptor states
 * the shapes it means.
 */

import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isPublicContract, type ToolContract, type z } from '@flybyme/mesh';

import { gateOf, keyOf, type ExposeEntry, type Gate } from './expose.js';

/** One exposed call, flattened. Everything a client generator or a router needs, and nothing live. */
export interface DescribedCall {
    /** `domain.action` — the name the browser calls it by. */
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    /** The route, relative to the API's base path. */
    readonly path: string;
    readonly gate: Gate;
    readonly input: unknown;
    readonly output: unknown;
    /** True when the contract modifies state — drives CSRF and the destructive-action confirmation. */
    readonly destructive: boolean;
    /** True when the response is a stream rather than a value. */
    readonly stream: boolean;
    /** Failures this call names, emitted into the generated client as a literal union. */
    readonly errors: readonly string[];
}

/**
 * The structural shape of an exposed call: keys, methods, paths, input/output schemas.
 *
 * Site-independent, gate-independent.
 */
export interface CallShape {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
    readonly errors?: readonly string[];
}

export interface ExposureDescriptor {
    /** The site this exposure belongs to, e.g. `surfdns.console`. */
    readonly application: string;
    /** Where the routes mount. Both the router and the generated client read this one value. */
    readonly base: string;
    /**
     * A hash of what is exposed and at what gate level.
     *
     * The site's gate hash. Changes when a gate changes or when routes change.
     */
    readonly exposure: string;
    /**
     * The site-independent, gate-independent shape hash over contracts and schemas.
     * Identical across all sites and releases calling the same contract shapes.
     * Answers: is this generated client stale?
     */
    readonly shapeHash: string;
    readonly calls: readonly DescribedCall[];
}

export interface DescribeOptions {
    readonly application: string;
    readonly base?: string;
    /**
     * Allow exposing a contract mesh marks `internal`.
     *
     * Off by default, and it should stay off. mesh defaults a contract to `internal` precisely so a
     * `defineCrud` that mints ten addressable contracts does not publish all ten; exposing one to
     * the public internet is a decision that deserves to be made out loud rather than by omission.
     */
    readonly allowInternal?: boolean;
}

export const DEFAULT_BASE_PATH = '/api';

/**
 * Build a descriptor from a site's exposure list.
 *
 * Every check here fails the build rather than degrading, because all of them describe a mistake
 * that is cheap now and expensive in production: an ungated contract, a route collision, an internal
 * contract published by accident.
 */
export function describeExposure(
    expose: readonly ExposeEntry[],
    options: DescribeOptions,
): ExposureDescriptor {
    const base = options.base ?? DEFAULT_BASE_PATH;
    const calls: DescribedCall[] = [];
    const routes = new Map<string, string>();
    const keys = new Set<string>();

    for (const entry of expose) {
        const contract = entry.contract;
        const key = keyOf(entry);

        if (keys.has(key)) {
            throw new Error(
                `${key} is exposed twice. Two entries for one contract means two gates, and the ` +
                `weaker one would win by accident of ordering.`,
            );
        }
        keys.add(key);

        // Throws on an ungated entry. The type union already made that unrepresentable in
        // TypeScript; this is the check for a list that arrived some other way.
        const gate = gateOf(entry);

        if (!isPublicContract(contract) && options.allowInternal !== true) {
            throw new Error(
                `${key} is marked internal by its own domain and cannot be exposed. ` +
                `Declare visibility: 'public' on the contract if it is meant to be part of that ` +
                `domain's published interface — exposing an internal contract publishes an ` +
                `implementation detail to the internet.`,
            );
        }

        const route = `${contract.rest.method.toUpperCase()} ${contract.rest.path}`;
        const owner = routes.get(route);
        if (owner !== undefined) {
            throw new Error(`Route collision: ${route} is claimed by both ${owner} and ${key}.`);
        }
        routes.set(route, key);

        calls.push({
            key,
            domain: contract.domain,
            action: contract.action,
            description: contract.description,
            method: contract.rest.method.toUpperCase(),
            path: contract.rest.path,
            gate,
            input: schemaOf(contract, 'inputSchema'),
            output: schemaOf(contract, 'outputSchema'),
            destructive: contract.destructive === true,
            stream: contract.rest.isStream === true,
            // Sorted, so a reordered declaration is not a change to the exposure hash.
            errors: [...(entry.errors ?? [])].sort(),
        });
    }

    // Sorted, so that the hash depends on what is exposed and not on the order someone happened to
    // write the list in. Reordering the file must not look like a change to the API.
    calls.sort((a, b) => a.key.localeCompare(b.key));

    const shapeHash = hashShape(calls);
    const exposure = hash({ application: options.application, base, calls });

    return { application: options.application, base, exposure, shapeHash, calls };
}

/**
 * A stable shape hash of contracts and their request/response schemas.
 *
 * Stable across runs, machines, key orderings, and independent of gates or site identity.
 * Answers: is this generated client stale?
 */
export function hashShape(
    calls: readonly CallShape[],
    hasher: (value: unknown) => string = hash,
): string {
    const sorted = [...calls].sort((a, b) => a.key.localeCompare(b.key));
    const entries = sorted.map((call) => [
        call.key,
        call.method,
        call.path,
        call.input,
        call.output,
        call.destructive === true,
        call.stream === true,
        [...(call.errors ?? [])].sort(),
    ]);
    return hasher(entries);
}

export interface ExposureDifference {
    /** The contract key that differed, e.g. `domains.zone_find`. */
    readonly contract: string;
    /** What aspect changed. */
    readonly kind: 'missing' | 'method' | 'path' | 'input' | 'output' | 'gate';
    /** Human-readable explanation of what changed. */
    readonly message: string;
}

export class ExposureMismatchError extends Error {
    public readonly contract: string;
    public readonly difference: string;
    public readonly differences: readonly ExposureDifference[];

    constructor(
        contract: string,
        difference: string,
        differences: readonly ExposureDifference[],
    ) {
        super(`Exposure mismatch: ${difference}`);
        this.name = 'ExposureMismatchError';
        this.contract = contract;
        this.difference = difference;
        this.differences = differences;
    }
}

export interface DescribedCallShape {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly gate?: Gate | string;
    readonly destructive?: boolean;
    readonly stream?: boolean;
    readonly errors?: readonly string[];
}

export interface ExposureSource {
    readonly calls: readonly DescribedCallShape[];
    readonly exposure?: string;
    readonly shapeHash?: string;
}

export interface RouteSource {
    readonly key: string;
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly gate: Gate;
    readonly method: string;
    readonly path: string;
}

export interface RouteTableSource {
    readonly routes: readonly RouteSource[];
    readonly exposure?: string;
    readonly shapeHash?: string;
}

export type ExposureTarget = ExposureSource | RouteTableSource;

export interface CheckExposureOptions {
    /**
     * Whether to check gates in addition to schemas and shapes.
     * Defaults to true if both sides define gates.
     */
    readonly checkGates?: boolean;
}

function formatGate(gate: Gate | string | undefined): string | undefined {
    if (gate === undefined) return undefined;
    if (typeof gate === 'string') return gate;
    if (gate.kind === 'auth') return gate.level;
    return `permission:${gate.permission}`;
}

export function diffExposure(
    client: ExposureTarget,
    api: ExposureTarget,
    options: CheckExposureOptions = {},
): readonly ExposureDifference[] {
    const differences: ExposureDifference[] = [];
    const clientMap = new Map<string, DescribedCallShape>();

    if ('calls' in client) {
        for (const call of client.calls) clientMap.set(call.key, call);
    } else {
        for (const route of client.routes) {
            clientMap.set(route.key, {
                key: route.key,
                method: route.method,
                path: route.path,
                input: schemaOf(route.contract, 'inputSchema'),
                output: schemaOf(route.contract, 'outputSchema'),
                gate: route.gate,
            });
        }
    }

    const apiMap = new Map<string, DescribedCallShape>();
    if ('calls' in api) {
        for (const call of api.calls) apiMap.set(call.key, call);
    } else {
        for (const route of api.routes) {
            apiMap.set(route.key, {
                key: route.key,
                method: route.method,
                path: route.path,
                input: schemaOf(route.contract, 'inputSchema'),
                output: schemaOf(route.contract, 'outputSchema'),
                gate: route.gate,
            });
        }
    }

    for (const [key, clientCall] of clientMap) {
        const apiCall = apiMap.get(key);
        if (apiCall === undefined) {
            differences.push({
                contract: key,
                kind: 'missing',
                message: `Contract "${key}" is not exposed by the API.`,
            });
            continue;
        }

        if (clientCall.method.toUpperCase() !== apiCall.method.toUpperCase()) {
            differences.push({
                contract: key,
                kind: 'method',
                message: `Contract "${key}" method changed from ${clientCall.method} to ${apiCall.method}.`,
            });
        }

        if (clientCall.path !== apiCall.path) {
            differences.push({
                contract: key,
                kind: 'path',
                message: `Contract "${key}" path changed from ${clientCall.path} to ${apiCall.path}.`,
            });
        }

        if (canonical(clientCall.input) !== canonical(apiCall.input)) {
            differences.push({
                contract: key,
                kind: 'input',
                message: `Contract "${key}" input schema changed.`,
            });
        }

        if (canonical(clientCall.output) !== canonical(apiCall.output)) {
            differences.push({
                contract: key,
                kind: 'output',
                message: `Contract "${key}" output schema changed.`,
            });
        }

        if (options.checkGates !== false) {
            const clientGate = formatGate(clientCall.gate);
            const apiGate = formatGate(apiCall.gate);
            if (clientGate !== undefined && apiGate !== undefined && clientGate !== apiGate) {
                differences.push({
                    contract: key,
                    kind: 'gate',
                    message: `Contract "${key}" gate changed from ${clientGate} to ${apiGate}.`,
                });
            }
        }
    }

    return differences;
}

export function assertExposureMatch(
    client: ExposureTarget,
    api: ExposureTarget,
    options?: CheckExposureOptions,
): void {
    const differences = diffExposure(client, api, options);
    if (differences.length > 0) {
        const first = differences[0];
        if (first !== undefined) {
            throw new ExposureMismatchError(first.contract, first.message, differences);
        }
    }
}

/**
 * A stable hash of a descriptor.
 *
 * Stable in the sense that matters: the same exposure produces the same hash across machines, runs
 * and key orderings, so a CI diff means the exposure actually changed. `JSON.stringify` alone would
 * not give that — object key order is insertion order — hence the sort.
 */
export function hashDescriptor(descriptor: ExposureDescriptor): string {
    const { exposure: _ignored, ...rest } = descriptor;
    return hash(rest);
}

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32)}`;
}

/** JSON with every object's keys sorted, so equal values serialise equally. */
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * A zod schema becomes JSON Schema.
 *
 * `zod-to-json-schema` rather than a hand-rolled walk, and specifically the same library mesh
 * already uses in its own Registry — a second converter would eventually disagree with the first
 * about some corner of the type system, and the disagreement would show up as a client that types
 * something the API rejects.
 */
export function schemaOf(
    contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>,
    which: 'inputSchema' | 'outputSchema',
): unknown {
    const schema: unknown = contract[which];

    // Checked before converting, because the converter does not fail on a non-schema — it returns
    // `{ "$schema": ... }` with no type at all, and a client generated from that would type the
    // call as `unknown` and look like it worked. A silent `unknown` is the one outcome this whole
    // file exists to prevent.
    if (typeof (schema as { safeParse?: unknown })?.safeParse !== 'function') {
        throw new Error(
            `${contract.domain}.${contract.action}'s ${which} is not a zod schema. ` +
            `A contract that cannot be described cannot be exposed: the generated client would ` +
            `type this call as unknown rather than failing.`,
        );
    }

    let described: unknown;
    try {
        described = zodToJsonSchema(schema as z.ZodTypeAny, { target: 'jsonSchema7', $refStrategy: 'none' });
    } catch (cause) {
        throw new Error(
            `Could not describe ${contract.domain}.${contract.action}'s ${which}: ` +
            `${cause instanceof Error ? cause.message : String(cause)}.`,
        );
    }

    // The same guard again on the way out: a conversion that produced nothing describable is the
    // same failure arriving by a different route.
    const keys = Object.keys(described as Record<string, unknown>).filter((k) => k !== '$schema');
    if (keys.length === 0) {
        throw new Error(
            `${contract.domain}.${contract.action}'s ${which} described to nothing. ` +
            `An empty description would become \`unknown\` in the generated client.`,
        );
    }

    return described;
}
