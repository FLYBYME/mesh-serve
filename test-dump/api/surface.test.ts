/**
 * **What a site serves without asking for it.**
 *
 * `ApiService.surfaceContracts` adds `approval.{check,decide,list}` and the two approval events to
 * every site's exposure, granted or not. The rule behind it: *the platform raises the question, so
 * the platform owes the way to answer it* — the agent surface parks a destructive call and hands out
 * an id, and if a site had to remember to grant `approval.decide`, the first one that forgot would
 * collect parked calls no person could ever act on while the agent polled them until they expired.
 *
 * This is the test that keeps that true. It caught the real thing once already: the routes were
 * added to the descriptor and not to the route table, so `/_describe` advertised
 * `POST /approval/decide` and the router answered `NO_ROUTE`.
 */

import { describe, expect, it } from 'vitest';

import { routeTable } from '../../src/api/methods/routes.js';
import { eventTable } from '../../src/api/methods/events.js';
import { describeExposure } from '../../src/api/schema/descriptor.js';
import {
    approvalCheckContract, approvalCrud, approvalDecideContract,
} from '../../src/approval/contracts/approval.contract.js';

/** Exactly what `surfaceContracts` returns, kept here so the test states the shape it asserts. */
const surface = [{
    package: '@flybyme/mesh-serve',
    version: '0.0.0',
    /**
     * Two gates for two audiences. `check` and `decide` are `user` because their handlers do the
     * real narrowing and an agent holding no role must be able to poll its own parked call;
     * `find`/`get` are the **queue** and carry the frozen input of calls, so they match the event
     * stream at `operator`.
     */
    contracts: [
        { key: 'approval.check', auth: 'user' as const },
        { key: 'approval.decide', auth: 'user' as const },
        { key: 'approval.find', auth: 'operator' as const },
        { key: 'approval.get', auth: 'operator' as const },
    ],
    events: [
        { key: 'approval.created', auth: 'operator' as const },
        { key: 'approval.updated', auth: 'operator' as const },
    ],
}];

const contracts = new Map<string, unknown>([
    ['approval.check', approvalCheckContract],
    ['approval.decide', approvalDecideContract],
    ['approval.find', approvalCrud.find],
    ['approval.get', approvalCrud.get],
]);
const lookup = ((key: string) => contracts.get(key)) as never;

describe('the routes a site gets whether it granted them or not', () => {
    /**
     * The regression this file exists for.
     *
     * A descriptor entry with no route is a call the site advertises and the router refuses. It
     * looked exactly like a missing grant from the outside, which is why it cost an hour.
     */
    it('routes every approval call', () => {
        const built = routeTable(surface, lookup, () => 'h');
        expect(built.unknown).toEqual([]);
        expect(built.routes.map((r) => `${r.contract.rest.method.toUpperCase()} ${r.contract.rest.path}`).sort())
            .toEqual(['GET /approvals', 'GET /approvals/:id', 'POST /approval/check', 'POST /approval/decide']);
    });

    /**
     * `routeTable` routes only what the composed release requires, and the platform's own calls are
     * required by nothing a part declared. Their keys have to join `requires` or they are filtered
     * out — silently, since a filtered contract is not "unknown".
     */
    it('survives the release requires filter only when its keys are added to it', () => {
        const partRequires = ['card.create'];
        expect(routeTable(surface, lookup, () => 'h', partRequires).routes).toHaveLength(0);

        const withSurface = [...partRequires, ...surface[0]!.contracts.map((c) => c.key)];
        expect(routeTable(surface, lookup, () => 'h', withSurface).routes).toHaveLength(4);
    });

    /**
     * The descriptor and the route table must agree — this is the pair that disagreed once, and the
     * symptom was a site advertising `POST /approval/decide` while the router answered `NO_ROUTE`.
     */
    it('describes them at the gates they are routed with', () => {
        const descriptor = describeExposure(
            surface[0]!.contracts.map((c) => ({
                contract: contracts.get(c.key) as never, auth: c.auth,
            })),
            { application: 'test', base: '/api' },
        );
        expect(descriptor.calls.map((c) => c.key).sort())
            .toEqual(['approval.check', 'approval.decide', 'approval.find', 'approval.get']);

        const gates = Object.fromEntries(descriptor.calls.map((c) => [
            c.key, c.gate.kind === 'auth' ? c.gate.level : c.gate.permission,
        ]));
        // The queue is operator; the agent's own poll is not, or an agent holding no role could
        // never redeem the id it was handed.
        expect(gates).toEqual({
            'approval.check': 'user', 'approval.decide': 'user',
            'approval.find': 'operator', 'approval.get': 'operator',
        });
    });
});

describe('the notification', () => {
    /**
     * **Gated at `operator`, which is coarser than the record, and deliberately so.**
     *
     * `decideDelivery` narrows an event to an organization, not to an approver. At `user` the frozen
     * input of a parked call would reach every member of the organization, including the ones who
     * cannot decide it. `operator` matches `DEFAULT_APPROVER` and fails closed.
     */
    it('streams the approval events to operators and no wider', () => {
        const built = eventTable(surface);
        expect(built.refused).toEqual([]);
        expect(built.events.map((e) => e.name).sort()).toEqual(['approval.created', 'approval.updated']);
        expect(built.events.every((e) => e.gate.kind === 'auth' && e.gate.level === 'operator')).toBe(true);
    });

    /**
     * A CRUD event's delivery scope *is* its collection's `scopedBy`, and `approval` declares
     * `tenantId`. An event that cannot be scoped is delivered to nobody — so had this been missed,
     * the stream would have connected and stayed silent forever, which is the failure
     * `schema/events.ts` was written to prevent.
     *
     * **This asserted the silence rather than preventing it, until 2026-09-10.** It expected
     * `tenantId` for both verbs, and `approval.updated` carries `{ id, patch, item }` — so the
     * scope was read off the top level of a payload that has no `tenantId` there, `decideDelivery`
     * answered `unscopable`, and every approval *decision* reached nobody while every approval
     * *request* arrived. The path is per verb because the row is: see `crudPayloadScope`.
     */
    it('reads a scope from the collection, from wherever that verb puts the row', () => {
        const built = eventTable(surface);
        const scopes = Object.fromEntries(built.events.map((e) => [e.name, e.scope]));

        expect(scopes).toEqual({
            'approval.created': { field: 'tenantId' },
            'approval.updated': { field: 'item.tenantId' },
        });
    });
});
