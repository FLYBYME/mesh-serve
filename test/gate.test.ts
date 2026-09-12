/**
 * The gate, which is the part that must be right.
 *
 * Every case here is reachable as a pure function call, which is the whole reason the gate takes
 * data and returns data. The previous one could only be exercised through a running HTTP server with
 * a database behind it, so its scope cases were never tested directly — and the multi-organization
 * case was wrong for months.
 */

import { describe, expect, it } from 'vitest';

import { gate, PASSWORD_ACTION, type Caller, type GateRequest } from '../src/serve/methods/gate.js';

const somebody: Caller = { userId: 'u1', roles: [] };

const ask = (overrides: Partial<GateRequest> = {}): GateRequest => ({
    key: 'organization.find',
    gate: { kind: 'auth', level: 'user' },
    caller: somebody,
    memberships: [],
    requestedScope: undefined,
    siteScope: undefined,
    ...overrides,
});

describe('the coarse gate', () => {
    it('lets an anonymous caller reach a public contract', () => {
        const outcome = gate(ask({ gate: { kind: 'auth', level: 'public' }, caller: undefined }));
        expect(outcome.allowed).toBe(true);
    });

    it('refuses an anonymous caller anywhere else', () => {
        const outcome = gate(ask({ caller: undefined }));
        expect(outcome).toMatchObject({ allowed: false, response: { status: 401 } });
    });

    it('refuses a provisional account everywhere except set_password', () => {
        const provisional: Caller = { userId: 'u1', roles: [], provisional: true };

        expect(gate(ask({ caller: provisional }))).toMatchObject({
            allowed: false,
            response: { body: { error: 'PROVISIONAL_ACCOUNT' } },
        });

        expect(gate(ask({ caller: provisional, key: PASSWORD_ACTION })).allowed).toBe(true);
    });

    /**
     * The order matters: a public contract stays public for an unclaimed account, because the
     * provisional check runs after the anonymous case. Otherwise the one credential a fresh cluster
     * hands out cannot reach the sign-in it was printed for.
     */
    it('does not let the provisional check swallow a public contract', () => {
        const outcome = gate(ask({
            gate: { kind: 'auth', level: 'public' },
            caller: { userId: 'u1', roles: [], provisional: true },
        }));

        expect(outcome.allowed).toBe(true);
    });

    /**
     * The concrete harm the case above prevents, named so it cannot be optimised away: an unclaimed
     * account that cannot sign out, and cannot sign in again either.
     */
    it('lets an unclaimed account sign out and sign in', () => {
        const unclaimed: Caller = { userId: 'u1', roles: [], provisional: true };

        for (const key of ['identity.sign_out', 'identity.ticket_issue']) {
            const outcome = gate(ask({ key, gate: { kind: 'auth', level: 'public' }, caller: unclaimed }));
            expect(outcome.allowed, `${key} must stay reachable`).toBe(true);
        }
    });

    it('checks a role for a level above user, and for a permission', () => {
        expect(gate(ask({ gate: { kind: 'auth', level: 'operator' } })).allowed).toBe(false);
        expect(gate(ask({
            gate: { kind: 'auth', level: 'operator' },
            caller: { userId: 'u1', roles: ['operator'] },
        })).allowed).toBe(true);

        expect(gate(ask({ gate: { kind: 'permission', permission: 'serve.site.create' } })).allowed).toBe(false);
        expect(gate(ask({
            gate: { kind: 'permission', permission: 'serve.site.create' },
            caller: { userId: 'u1', roles: ['serve.site.create'] },
        })).allowed).toBe(true);
    });
});

/** The six cases in `spec/identity.md` §8, one test each. */
describe('resolving the scope', () => {
    const inOrgs = (...ids: string[]) => ids.map((organizationId) => ({ organizationId }));

    it('1. honours an explicit selection the caller is a member of', () => {
        const outcome = gate(ask({ memberships: inOrgs('a', 'b'), requestedScope: 'b' }));
        expect(outcome).toMatchObject({ allowed: true, resolvedScope: 'b' });
    });

    /**
     * **404, not 403.** Whether an organization exists is not something an unrelated caller gets to
     * confirm by probing, and a 403 confirms it.
     */
    it('2. answers 404 for an organization the caller is not in', () => {
        const outcome = gate(ask({ memberships: inOrgs('a'), requestedScope: 'b' }));
        expect(outcome).toMatchObject({
            allowed: false,
            response: { status: 404, body: { error: 'NO_SUCH_ORGANIZATION' } },
        });
    });

    it('3. uses the only membership when there is one', () => {
        const outcome = gate(ask({ memberships: inOrgs('a') }));
        expect(outcome).toMatchObject({ allowed: true, resolvedScope: 'a' });
    });

    /**
     * The case that was wrong for months. An operator becomes a member of every tenant the moment
     * they seed one, and from then on every scoped read answered 401 — rendered to somebody who was
     * signed in as *"You need to sign in"*.
     */
    it("4. falls back to the site's organization when the caller is a member of it", () => {
        const outcome = gate(ask({ memberships: inOrgs('a', 'b'), siteScope: 'b' }));
        expect(outcome).toMatchObject({ allowed: true, resolvedScope: 'b' });
    });

    it('5. resolves nothing when several memberships and none is this site', () => {
        const outcome = gate(ask({ memberships: inOrgs('a', 'b'), siteScope: 'c' }));
        expect(outcome).toMatchObject({ allowed: true, resolvedScope: undefined });
    });

    it('6. resolves nothing for a caller in no organization', () => {
        const outcome = gate(ask({ memberships: [] }));
        expect(outcome).toMatchObject({ allowed: true, resolvedScope: undefined });
    });

    /** A site cannot add to what the caller holds. It chooses among, and that is the whole rule. */
    it('never grants a scope the caller is not a member of', () => {
        const outcome = gate(ask({ memberships: [], siteScope: 'a' }));
        expect(outcome).toMatchObject({ resolvedScope: undefined });
    });
});
