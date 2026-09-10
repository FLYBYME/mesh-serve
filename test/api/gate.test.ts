import { defineContract, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import {
    callerMeta,
    executeGate,
    ADMIN_ROLE,
    OPERATOR_ROLE,
    isOperator,
    type Caller,
    type GateOutcome,
} from '../../src/api/methods/gate.js';
import { decideDelivery, type Subscriber } from '../../src/api/methods/delivery.js';
import { DELIVERED_SCOPED_BY, registryLookup } from '../../src/api/methods/events.js';
import { gateOf } from '../../src/api/schema/expose.js';
import type { DescribedEvent } from '../../src/api/schema/events.js';

const testContract = defineContract({
    domain: 'fleet',
    action: 'node_status',
    description: 'Node status test contract',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    rest: { method: 'GET', path: '/node/status' },
    print: () => '',
});

describe('gate: operator level enforcement', () => {
    it('recognizes operator as a valid AuthLevel in gateOf', () => {
        const gate = gateOf({ contract: testContract, auth: 'operator' });
        expect(gate).toEqual({ kind: 'auth', level: 'operator' });
    });

    it('refuses unauthenticated callers on operator gate with 401', async () => {
        const outcome: GateOutcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: undefined,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.status).toBe(401);
            expect(outcome.code).toBe('UNAUTHENTICATED');
        }
    });

    it('refuses an admin caller with no operator standing (403)', async () => {
        // An organization or platform admin is NOT a platform operator.
        // The whole point of the distinction is that an admin must not reach the fleet.
        const adminCaller: Caller = {
            userId: 'user-admin',
            roles: [ADMIN_ROLE],
        };

        const outcome: GateOutcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: adminCaller,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.status).toBe(403);
            expect(outcome.code).toBe('FORBIDDEN');
            expect(outcome.message).toContain('requires the operator role');
        }
    });

    it('refuses an admin caller even if authorize hook claims authorized', async () => {
        // Coarse gate runs before authorize hook and cannot be bypassed.
        const adminCaller: Caller = {
            userId: 'user-admin',
            roles: [ADMIN_ROLE],
        };

        const outcome: GateOutcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: adminCaller,
            requestedScope: 'tenant-1',
            input: {},
            authorize: async () => ({ authorized: true, resolvedScope: 'tenant-1' }),
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.status).toBe(403);
            expect(outcome.code).toBe('FORBIDDEN');
        }
    });

    it('admits a caller holding the operator role', async () => {
        const operatorCaller: Caller = {
            userId: 'user-operator',
            roles: [OPERATOR_ROLE],
        };

        const outcome: GateOutcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: operatorCaller,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(true);
    });

    it('admits a caller holding both admin and operator roles', async () => {
        const dualCaller: Caller = {
            userId: 'user-dual',
            roles: [ADMIN_ROLE, OPERATOR_ROLE],
        };

        const outcome: GateOutcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: dualCaller,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(true);
    });
});

describe('isOperator reconciliation with delivery', () => {
    it('isOperator returns true only for callers with the operator role', () => {
        expect(isOperator(undefined)).toBe(false);
        expect(isOperator({ userId: 'u1', roles: [] })).toBe(false);
        expect(isOperator({ userId: 'u2', roles: ['user', 'admin'] })).toBe(false);
        expect(isOperator({ userId: 'u3', roles: ['user', 'operator'] })).toBe(true);
    });

    it('delivery allows operator across organizations and restricts admin to resolved scope', () => {
        const event: DescribedEvent = {
            name: 'node.changed',
            gate: { kind: 'auth', level: 'user' },
            scope: { field: 'tenantId' },
        };
        const payload = { tenantId: 'org-alpha' };

        const adminSubscriber: Subscriber = {
            userId: 'admin-1',
            scope: 'org-beta',
            operator: false,
        };

        const operatorSubscriber: Subscriber = {
            userId: 'operator-1',
            scope: 'org-beta',
            operator: true,
        };

        // Admin of org-beta cannot see org-alpha events
        expect(decideDelivery(event, payload, adminSubscriber)).toEqual({
            deliver: false,
            reason: 'out-of-scope',
        });

        // Operator sees across organizations
        expect(decideDelivery(event, payload, operatorSubscriber)).toEqual({
            deliver: true,
        });
    });
});

/**
 * **The account a cluster makes for itself, and the wall around it.**
 *
 * identity creates one provisional operator on first boot, because a platform with no accounts
 * cannot be signed into and something has to make the first person. The flag is what stops it being
 * a permanent back door.
 *
 * These assert the *refusal*, not the creation. A `provisional` field that nothing enforced would be
 * worse than none — it would read, in the schema and in the log, as a protection that exists.
 */
describe('a provisional account is refused until it is claimed', () => {
    const provisional: Caller = { userId: 'u1', roles: [OPERATOR_ROLE], provisional: true };
    const claimed: Caller = { userId: 'u1', roles: [OPERATOR_ROLE] };

    const setPassword = defineContract({
        domain: 'identity',
        action: 'set_password',
        description: 'Set your own password.',
        inputSchema: z.object({ password: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        rest: { method: 'POST', path: '/identity/password' },
        print: () => '',
    });

    it('refuses it even holding the operator role', async () => {
        // The role is real and the account still cannot act. The flag outranks what it holds, which
        // is the point: it is created WITH the role it will need, so that claiming it is one step.
        const outcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: provisional,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.status).toBe(403);
            expect(outcome.code).toBe('PROVISIONAL_ACCOUNT');
        }
    });

    it('refuses it on a public contract too', async () => {
        // Ahead of every level including `public`, so there is one place the flag is checked and no
        // contract that forgets to ask. A provisional account is not a weaker account; it is an
        // account that does one thing.
        const outcome = await executeGate({
            gate: { kind: 'auth', level: 'public' },
            contract: testContract,
            caller: provisional,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(false);
    });

    it('lets it set its own password, which is the one way out', async () => {
        const outcome = await executeGate({
            gate: { kind: 'auth', level: 'user' },
            contract: setPassword,
            caller: provisional,
            requestedScope: undefined,
            input: { password: 'a new one' },
        });

        expect(outcome.ok).toBe(true);
    });

    it('leaves an ordinary account alone', async () => {
        // The control. Without it every assertion above passes for a caller who is simply refused
        // for some other reason entirely.
        const outcome = await executeGate({
            gate: { kind: 'auth', level: 'operator' },
            contract: testContract,
            caller: claimed,
            requestedScope: undefined,
            input: {},
        });

        expect(outcome.ok).toBe(true);
    });
});

/**
 * **The scope has to reach mesh under the name each collection spells it with.**
 *
 * mesh resolves a scoped read by looking on `meta.user` for the field the collection named, then for
 * its snake_case spelling. `scopedBy: 'tenantId'` therefore finds `tenant_id`, and
 * `scopedBy: 'organizationId'` found nothing at all — so `membership.find` refused every caller with
 * *Scoped collection "membership" requires a resolved "organizationId" scope*, while being exposed
 * on the control site at `operator` the whole time.
 *
 * Nobody noticed because nothing called it. That is the shape freeze gate V9 exists for: `public`
 * means *may be exposed*, exposure makes it a promise, and a promise nothing has ever tested is a
 * route table entry.
 *
 * These assertions are deliberately about the **field names**. A test that asserted "the scope is
 * carried" would have passed on the broken version, because it was carried — under one name, and the
 * collection asked for another.
 */
describe('callerMeta carries the resolved scope under every name a scopedBy uses', () => {
    const caller: Caller = { userId: 'u-1', roles: [OPERATOR_ROLE] };

    it('spells the scope both tenant_id and organizationId', () => {
        const meta = callerMeta(caller, 'org-7');

        // What `scopedBy: 'tenantId'` finds, via mesh's snake_case fallback.
        expect(meta.tenant_id).toBe('org-7');
        // What `scopedBy: 'organizationId'` finds. Absent until 2026-09-10.
        expect(meta.organizationId).toBe('org-7');
    });

    it('carries the caller and the roles unchanged', () => {
        const meta = callerMeta(caller, 'org-7');

        expect(meta.id).toBe('u-1');
        expect(meta.roles).toEqual([OPERATOR_ROLE]);
    });

    /**
     * A caller with no resolved scope gets an empty string rather than a missing key, which is what
     * every scoped collection then refuses on. Refusing is right: `resolveCallerScope` requires a
     * non-empty string, so an unscoped caller cannot read a scoped collection at all.
     */
    it('leaves an unscoped caller unable to resolve either name', () => {
        const meta = callerMeta(caller, undefined);

        expect(meta.tenant_id).toBe('');
        expect(meta.organizationId).toBe('');
    });

    /**
     * **The scope is the gate's answer, never the request's.**
     *
     * The only thing that reaches this function is `outcome.scope`, resolved from the caller's own
     * memberships. Copying it under a second name does not create a second way to set it — worth an
     * assertion because "the same value under two names" is exactly the shape that grows a third
     * name somebody can supply.
     */
    it('takes the scope only from its argument', () => {
        expect(callerMeta(caller, 'a').organizationId).toBe('a');
        expect(callerMeta({ userId: 'u-1', roles: [] }, 'b').organizationId).toBe('b');
    });
});

/**
 * **An organization's own events, which no site could stream until 2026-09-10.**
 *
 * `scopedBy` on a `defineCrud` answers two questions with one word — which rows a caller may read,
 * and which subscribers hear a change — and `organization` is the collection where they differ. It
 * has no `scopedBy` at all, because an organization is not data inside a tenant; it **is** the
 * tenant, and no column points at one. Reads are narrowed by identity's `beforeCrud` instead.
 *
 * That left `organization.created | updated | deleted` falling through every branch of
 * `registryLookup`, refused as unscopable, and **absent from every site's event table** — which is
 * why the identity app's organization list only changed on a page reload while every other list on
 * the same screen streamed. A refused event is missing from the descriptor, not reported in it, so
 * nothing anywhere said the stream was not there.
 *
 * `DELIVERED_SCOPED_BY` states the delivery scope for that one collection. These assertions are
 * about `id` specifically: an event delivered by the wrong field is delivered to the wrong people,
 * and *is it in the table* would pass either way.
 */
describe('organization events are delivered by the organization they are about', () => {
    it('is looked up as scoped by id, not refused', () => {
        expect(registryLookup('organization.created')).toEqual({ scopedBy: 'id' });
        expect(registryLookup('organization.updated')).toEqual({ scopedBy: 'id' });
        expect(registryLookup('organization.deleted')).toEqual({ scopedBy: 'id' });
    });

    /** The map outranks the lists, so a row scope arriving later cannot quietly take over. */
    it('states delivery for exactly one collection', () => {
        expect([...DELIVERED_SCOPED_BY.keys()]).toEqual(['organization']);
    });

    const event: DescribedEvent = {
        name: 'organization.updated',
        scope: { field: 'id' },
        gate: { kind: 'auth', level: 'user' },
    };
    // The row is the organization, so its own id is the scope the subscriber is compared against.
    const payload = { id: 'org-alpha', slug: 'alpha', name: 'Alpha' };

    it('reaches a member of that organization', () => {
        expect(decideDelivery(event, payload, { scope: 'org-alpha' } as Subscriber))
            .toEqual({ deliver: true });
    });

    it('does not reach a member of another one', () => {
        expect(decideDelivery(event, payload, { scope: 'org-beta' } as Subscriber))
            .toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    /**
     * The operator branch, and it is what makes the identity app work at all: a cluster operator
     * belongs to no organization by design, so without this they would hear about none of them.
     */
    it('reaches a cluster operator', () => {
        expect(decideDelivery(event, payload, { operator: true } as Subscriber))
            .toEqual({ deliver: true });
    });

    it('reaches nobody who is in no organization', () => {
        expect(decideDelivery(event, payload, {} as Subscriber))
            .toEqual({ deliver: false, reason: 'no-subscriber-scope' });
    });
});
