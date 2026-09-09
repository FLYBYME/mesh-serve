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
    approvalCheckContract, approvalDecideContract, approvalListContract,
} from '../../src/approval/contracts/approval.contract.js';

/** Exactly what `surfaceContracts` returns, kept here so the test states the shape it asserts. */
const surface = [{
    package: '@flybyme/mesh-serve',
    version: '0.0.0',
    contracts: [
        { key: 'approval.check', auth: 'user' as const },
        { key: 'approval.decide', auth: 'user' as const },
        { key: 'approval.list', auth: 'user' as const },
    ],
    events: [
        { key: 'approval.created', auth: 'operator' as const },
        { key: 'approval.updated', auth: 'operator' as const },
    ],
}];

const contracts = new Map<string, unknown>([
    ['approval.check', approvalCheckContract],
    ['approval.decide', approvalDecideContract],
    ['approval.list', approvalListContract],
]);
const lookup = ((key: string) => contracts.get(key)) as never;

describe('the routes a site gets whether it granted them or not', () => {
    /**
     * The regression this file exists for.
     *
     * A descriptor entry with no route is a call the site advertises and the router refuses. It
     * looked exactly like a missing grant from the outside, which is why it cost an hour.
     */
    it('routes all three approval calls', () => {
        const built = routeTable(surface, lookup, () => 'h');
        expect(built.unknown).toEqual([]);
        expect(built.routes.map((r) => `${r.contract.rest.method.toUpperCase()} ${r.contract.rest.path}`).sort())
            .toEqual(['GET /approvals', 'POST /approval/check', 'POST /approval/decide']);
    });

    /**
     * `routeTable` routes only what the composed release requires, and the platform's own calls are
     * required by nothing a part declared. Their keys have to join `requires` or they are filtered
     * out — silently, since a filtered contract is not "unknown".
     */
    it('survives the release requires filter only when its keys are added to it', () => {
        const partRequires = ['card.create'];
        expect(routeTable(surface, lookup, () => 'h', partRequires).routes).toHaveLength(0);

        const withSurface = [...partRequires, 'approval.check', 'approval.decide', 'approval.list'];
        expect(routeTable(surface, lookup, () => 'h', withSurface).routes).toHaveLength(3);
    });

    it('describes them at user, matching what is routed', () => {
        const descriptor = describeExposure(
            surface[0]!.contracts.map((c) => ({
                contract: contracts.get(c.key) as never, auth: c.auth,
            })),
            { application: 'test', base: '/api' },
        );
        expect(descriptor.calls.map((c) => c.key).sort())
            .toEqual(['approval.check', 'approval.decide', 'approval.list']);
        expect(descriptor.calls.every((c) => c.gate.kind === 'auth' && c.gate.level === 'user')).toBe(true);
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
     */
    it('reads a scope from the collection rather than being global', () => {
        const built = eventTable(surface);
        for (const event of built.events) {
            expect(event.scope).not.toBe('global');
            expect(event.scope).toEqual({ field: 'tenantId' });
        }
    });
});
