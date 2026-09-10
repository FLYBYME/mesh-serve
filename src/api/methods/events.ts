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

/**
 * How an event name becomes a definition. The framework's registry; a Map in a test.
 *
 * `refusal` is for an event that is *known* and still cannot be narrowed, which is a different
 * answer from `scopedBy: undefined` (*nobody said what narrows this*) and from `undefined` (*no
 * module defines this*). It carries its own sentence because the three read identically to a person
 * staring at an open stream that delivers nothing.
 */
export type EventLookup = (name: string) => {
    readonly scopedBy?: string;
    readonly refusal?: string;
} | undefined;

/**
 * **Where the row is in a CRUD event's payload, which is not the same place for all three.**
 *
 * `scopedBy` names a field *on the row*, and mesh does not put the row in the same place for every
 * verb (`DatabaseMiddleware`):
 *
 * | verb | payload | the row |
 * | --- | --- | --- |
 * | `created` | the row itself | top level |
 * | `updated` | `{ id, patch, item }` | under `item` |
 * | `deleted` | `{ id }` | **not there** |
 *
 * `readScope` walks a dotted path, so `updated` is `item.<field>` and that is the whole fix. Without
 * it every `updated` on a scoped collection read its scope from the top level, found nothing, and
 * `decideDelivery` answered `unscopable` — *delivered to nobody, operator included.*
 *
 * **The symptom was a board that only grew.** A card created in another tab appeared; the same card
 * moved between columns did not, and neither did one deleted. It applies to every scoped collection
 * on the platform — `site`, `release`, `approval`, `membership` — and stayed hidden because the
 * collections whose lists people watched most were globally delivered, where the payload is never
 * consulted at all.
 *
 * **`deleted` cannot be fixed here.** The payload is `{ id }`: the row is gone and nothing in the
 * event says whose it was. mesh would have to emit the scope, and mesh is frozen — so this refuses
 * it by name, loudly, rather than accepting a subscription that can never deliver. A client wanting
 * live removals re-reads. Freeze gate V6 is where the general fix belongs.
 */
function crudPayloadScope(action: string, scopedBy: string): { scopedBy?: string; refusal?: string } {
    if (action === 'created') return { scopedBy };
    if (action === 'updated') return { scopedBy: `item.${scopedBy}` };
    return {
        refusal:
            `a delete carries only { id }, so nothing in the payload says which "${scopedBy}" it `
            + 'belonged to and it can never be narrowed to a subscriber. Re-read the collection to '
            + 'see removals.',
    };
}

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

/**
 * **Where the delivery scope is not the row scope, named per collection.**
 *
 * `scopedBy` on a `defineCrud` says two things at once — *which rows a caller may read* and *which
 * subscribers hear a change* — and for one collection those are different questions.
 *
 * **`organization` is the case, and it is the only one.** It has no `scopedBy`, because an
 * organization is not data inside a tenant; it *is* the tenant, and there is no column pointing at
 * one. Reads are narrowed instead by identity's `beforeCrud`, which walks the caller's memberships
 * and exempts an operator. That works for reads and says nothing about events, so
 * `organization.created | updated | deleted` fell through every branch of `registryLookup`, were
 * refused as unscopable, and **never appeared in any site's event table.**
 *
 * The symptom: *"the identity org list needs to watch for collection events… I have to reload the
 * page to get the org list to update."* Every other collection on that screen streams. This one
 * could not, and nothing said so — a refused event is absent from the descriptor, not reported.
 *
 * `id` is the right field because `decideDelivery` compares `payload[scope]` to the subscriber's own
 * resolved scope, and a caller's scope **is** an organization id. So a member hears about their own
 * organization, an operator hears about all of them by the operator branch, and a caller in no
 * organization hears nothing. That is the same answer `beforeCrud` gives for reads, reached by a
 * different mechanism because the two questions are asked in different places.
 *
 * **This map outranks both lists below**, including a declared `scopedBy`: it exists precisely to
 * say *delivery differs here*, so a collection that later grows a row scope must not silently start
 * delivering by it.
 *
 * The general fix is for `defineCrud` to take the two separately, which is a mesh change and mesh is
 * frozen — so this is mesh-serve stating it for its own collections, the same way
 * `GLOBALLY_DELIVERED` already does. Freeze gate V6.
 */
export const DELIVERED_SCOPED_BY = new Map<string, string>([
    ['organization', 'id'],
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
            // Stated delivery wins over everything, including a declared row scope — see the map.
            const delivered = DELIVERED_SCOPED_BY.get(domain);
            if (delivered !== undefined) return { scopedBy: delivered };

            const crud = globalCrudRegistry.get(domain);
            if (crud !== undefined) {
                // A declared row scope wins over the lists below: it is a stronger statement than
                // either, and a collection that grows one must not keep being delivered globally.
                // Where the row *is* in the payload depends on the verb — see `crudPayloadScope`.
                if (crud.scopedBy !== undefined) return crudPayloadScope(action, crud.scopedBy);
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

            // Known, and still undeliverable — a delete on a scoped collection. Its own sentence,
            // because "nobody said what narrows this" would send a reader looking for a missing
            // declaration that is in fact present.
            if (definition.refusal !== undefined) {
                refused.push({ name, reason: definition.refusal });
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
