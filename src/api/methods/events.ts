/**
 * A site's event subscriptions, derived from its record.
 *
 * The twin of `routeTable`, and the same join: `site.mesh[].events` names keys and gates, the event
 * registry supplies the scope and the schema, and the api is the only place both halves are in hand.
 *
 * ## Where a scope comes from, and why not from the site
 *
 * mesh-api's exposure list made the *exposer* state the scope — `{ event, scope: { field: 'orgId' } }`.
 * That is the wrong owner. **Which field of a payload names an organization is a fact about the
 * event**, known to whoever defined it, and a site copying it into its own record is a second place
 * for it to be wrong. mesh 2.3.0 put `scopedBy` on the definition, so the site chooses the gate and
 * nothing else — exactly as it does for a contract.
 *
 * ## The rule everything here serves
 *
 * **An event that cannot be scoped is delivered to nobody.** An unresolvable subscription is
 * therefore refused *at subscribe time* rather than accepted and silently starved: a stream that
 * connects and never delivers is the hardest failure in this system to diagnose, because nothing
 * errors and nothing arrives.
 */

import { globalCrudRegistry, globalEventRegistry } from '@flybyme/mesh';

import type { ExposedContract, MeshDependency } from '../../cdn/schema/site.js';
import type { EventScope } from '../schema/events.js';
import type { Gate } from '../schema/expose.js';

/** One event a site streams: what it is called, who may receive it, and what narrows it. */
export interface ExposedEvent {
    readonly name: string;
    readonly gate: Gate;
    readonly scope: EventScope;
}

export interface EventTable {
    readonly events: readonly ExposedEvent[];
    /**
     * Named events that cannot be streamed, and why.
     *
     * Two causes, and both must be **reported rather than silently dropped**: an event no module
     * defines, and an event whose definition declares no scope. The second is the dangerous one —
     * it looks configured, it connects, and it delivers nothing forever.
     */
    readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

/** How an event name becomes a definition. The framework's registry; a Map in a test. */
export type EventLookup = (name: string) => { readonly scopedBy?: string } | undefined;

/**
 * Collections whose rows belong to everyone, so their CRUD events are delivered to everyone.
 *
 * **`defineCrud` has two states and the world has three.** A collection either declares `scopedBy`
 * — rows belong to an organization — or declares nothing, and the framework reads *nothing* as
 * *cannot be narrowed*, which is correct for a collection nobody has thought about and wrong for
 * one that is global on purpose. `defineEvent` has the third state and calls it `scopedBy: 'global'`
 * (`catalog.version_published` uses it); `defineCrud` has no way to say the same thing, because its
 * `scopedBy` names a *field* and there is no field called global.
 *
 * The cost of the missing state was concrete: a console granted `part.created`, `node.updated` and
 * thirteen others got a stream that opened, a subscription that succeeded, and a list that never
 * updated — because each of those was refused at deploy for having no scope. The refusal was right
 * about the mechanism and wrong about the intent.
 *
 * **Global delivery is not open delivery.** A subscriber still has to pass the gate the site put on
 * that event, so `node.updated` at `operator` reaches operators and nobody else. What global
 * settles is that there is no *tenant* narrowing to do, which for these collections is a fact
 * rather than a permission:
 *
 * - `part`, `partVersion` — one flat public namespace. A catalog that hid its contents would not be
 *   one, which is the same reasoning that made `catalog.version_published` global.
 * - `artifact` — content-addressed. Two organizations building identical source produced the same
 *   artifact; there is no owner to narrow to.
 * - `node`, `group` — the fleet belongs to the deployment, not to an organization. A machine is not
 *   owned by a tenant, which is why scoping it would be a lie rather than a restriction.
 * - `role` — platform definitions (such as builtin roles `public` and `authenticated`). The role catalogue
 *   contains no tenant data and is safe to be read globally by authenticated operators.
 *
 * Anything not listed here keeps the framework's answer, so a new collection that forgets to say
 * what it is still fails loudly instead of quietly streaming to everybody.
 *
 * ---
 *
 * **This list is this repository's own collections, and it used to be the only way in.**
 *
 * Every name above is defined in `src/`. An application published to this platform could never join
 * it, because joining meant editing a file in mesh-serve — so *every* third-party collection was
 * undeliverable, permanently, whatever it was. flowboard found it the obvious way: seven collections,
 * twenty-one derived events, and `/events` refusing the entire subscription with
 * `no module here defines it` twenty-one times.
 *
 * The decision was in the wrong repository. It belongs to the collection that owns the data, beside
 * `scopedBy`, which is where `defineCrud`'s `delivery: 'global'` now puts it — and `registryLookup`
 * reads that first. This set stays as what it always described: the platform's own collections,
 * kept here rather than threaded through six `defineCrud` calls for no gain, and now one of two
 * routes to the same answer rather than the only one.
 */
export const GLOBALLY_DELIVERED = new Set([
    'part', 'partVersion', 'artifact', 'node', 'group', 'role',
]);

export const registryLookup: EventLookup = (name) => {
    const fromEvents = globalEventRegistry.get(name);
    if (fromEvents !== undefined) {
        return fromEvents;
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
        const domain = name.slice(0, dot);
        const action = name.slice(dot + 1);
        if (action === 'created' || action === 'updated' || action === 'deleted') {
            const crud = globalCrudRegistry.get(domain);
            if (crud !== undefined) {
                // A declared row scope always wins: it is a stronger statement than either list,
                // and a collection that grows one later must not keep being delivered globally.
                if (crud.scopedBy !== undefined) return { scopedBy: crud.scopedBy };
                // What the collection says about itself, then what this repository says about its own.
                if (crud.delivery === 'global') return { scopedBy: 'global' };
                if (GLOBALLY_DELIVERED.has(domain)) return { scopedBy: 'global' };
            }
        }
    }
    return undefined;
};

export function eventTable(
    mesh: readonly MeshDependency[],
    lookup: EventLookup = registryLookup,
): EventTable {
    const events: ExposedEvent[] = [];
    const refused: { name: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const dependency of mesh) {
        for (const exposed of dependency.events) {
            const name = exposed.key;
            if (seen.has(name)) continue;
            seen.add(name);

            const definition = lookup(name);
            if (definition === undefined) {
                refused.push({ name, reason: 'no module here defines it' });
                continue;
            }

            const scopedBy = definition.scopedBy;
            if (scopedBy === undefined) {
                // The event author did not say what narrows it, so nothing can. Refused loudly
                // rather than accepted: `decideDelivery` would answer `unscopable` for every payload
                // and the subscriber would sit on an open connection receiving nothing.
                refused.push({
                    name,
                    reason: 'its definition declares no scopedBy, so it can never be narrowed to a '
                        + 'subscriber — an event that cannot be scoped is delivered to nobody',
                });
                continue;
            }

            events.push({
                name,
                gate: gateOf(exposed),
                // `'global'` is a value an event author typed deliberately. It is the one setting
                // that means everybody, and it is never reached by failing to find anything.
                scope: scopedBy === 'global' ? 'global' : { field: scopedBy },
            });
        }
    }

    events.sort((a, b) => a.name.localeCompare(b.name));
    return { events, refused };
}

const gateOf = (exposed: ExposedContract): Gate =>
    'auth' in exposed
        ? { kind: 'auth', level: exposed.auth }
        : { kind: 'permission', permission: exposed.permission };
