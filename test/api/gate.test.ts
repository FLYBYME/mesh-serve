import { defineContract, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import {
    executeGate,
    ADMIN_ROLE,
    OPERATOR_ROLE,
    isOperator,
    type Caller,
    type GateOutcome,
} from '../../src/api/methods/gate.js';
import { decideDelivery, type Subscriber } from '../../src/api/methods/delivery.js';
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
