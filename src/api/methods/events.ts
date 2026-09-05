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

import { globalEventRegistry } from '@flybyme/mesh';

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

export const registryLookup: EventLookup = (name) => globalEventRegistry.get(name);

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
