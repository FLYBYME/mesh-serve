/**
 * **The `permission` gate, which until now was evaluated by nobody.**
 *
 * `Gate` has two kinds. `auth` carries one of four levels and `checkCoarse` decides it. `permission`
 * carries an arbitrary key — `dns.write`, `card.update` — and its whole design is that the site's
 * `authorize` hook answers it, because *"only the site knows what `identity.invite` means"*.
 *
 * The hook the platform installs is `membershipAuthorize`, and it destructured
 * `{ caller, requestedScope, siteScope }`. `permission` was passed in by `executeGate` and never
 * read, so the hook returned whatever `resolveScope` said and every permission-gated contract
 * admitted exactly the callers `auth: 'user'` would have. Roadmap **F30**.
 *
 * Nothing declared a permission entry, so nothing was reachable — which is precisely why it stayed
 * broken: the mechanism was documented, typed, and had no caller to find out. The tests below are
 * that caller.
 *
 * They exercise the hook directly rather than over HTTP. `executeGate`'s half is covered by
 * `gate.ts`'s own tests; what was missing is anybody asking the hook the second question.
 */

import { describe, expect, it } from 'vitest';

import { membershipAuthorize } from '../../src/api/methods/authorize.js';
import type { AuthorizeInput, Caller } from '../../src/api/methods/gate.js';

interface Membership {
    readonly organizationId: string;
    readonly name?: string;
    readonly roleKey?: string;
}

/** Every call the hook made, so a test can assert what identity was *asked*, not only the answer. */
interface Asked {
    readonly tool: string;
    readonly params: Record<string, unknown>;
}

function harness(options: {
    readonly memberships?: readonly Membership[];
    /** Contracts `identity.permits` says yes to, given the roles it is handed. */
    readonly grants?: readonly { readonly role: string; readonly contract: string }[];
    /** Force a malformed answer from `identity.permits`, to pin the fail-closed direction. */
    readonly permitsAnswers?: unknown;
}) {
    const asked: Asked[] = [];

    const call = async (tool: string, params: unknown): Promise<unknown> => {
        asked.push({ tool, params: params as Record<string, unknown> });

        if (tool === 'identity.whoami') {
            return { organizations: options.memberships ?? [] };
        }

        if (tool === 'identity.permits') {
            if ('permitsAnswers' in options) return options.permitsAnswers;
            const { roles, contract } = params as { roles: string[]; contract: string };
            const permitted = (options.grants ?? []).some(
                (g) => roles.includes(g.role) && g.contract === contract,
            );
            return { permitted };
        }

        throw new Error(`unexpected call: ${tool}`);
    };

    return { asked, hook: membershipAuthorize(call) };
}

const caller = (roles: readonly string[] = []): Caller => ({ userId: 'u1', roles });

const ask = (permission: string | undefined, over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
    caller: caller(),
    requestedScope: undefined,
    siteScope: undefined,
    permission,
    gate: permission === undefined
        ? { kind: 'auth', level: 'user' }
        : { kind: 'permission', permission },
    contract: { domain: 'card', action: 'update' } as AuthorizeInput['contract'],
    input: {},
    ...over,
});

describe('a permission gate is actually evaluated', () => {
    it('refuses a signed-in caller who holds no role granting it', async () => {
        // The assertion the whole item turns on. Before F30 this was `authorized: true`.
        const { hook } = harness({ memberships: [{ organizationId: 'org-1' }] });

        const answer = await hook(ask('card.update'));

        expect(answer.authorized).toBe(false);
        expect(answer.authorized === false && answer.status).toBe(403);
    });

    it('allows a caller whose cluster role carries the grant', async () => {
        const { hook } = harness({
            memberships: [{ organizationId: 'org-1' }],
            grants: [{ role: 'operator', contract: 'card.update' }],
        });

        const answer = await hook(ask('card.update', { caller: caller(['operator']) }));

        expect(answer.authorized).toBe(true);
    });

    it('does not ask identity.permits at all when the gate carries no permission', async () => {
        // An `auth` gate is `checkCoarse`'s decision and was already made before the hook ran.
        // Asking identity a second question about it would be a round trip per request, forever.
        const { asked, hook } = harness({ memberships: [{ organizationId: 'org-1' }] });

        const answer = await hook(ask(undefined));

        expect(answer.authorized).toBe(true);
        expect(asked.map((a) => a.tool)).toEqual(['identity.whoami']);
    });
});

/**
 * **An organization role is not a cluster role, and looking only at the principal misses it.**
 *
 * `Caller.roles` is platform standing; the comment on it says *"Organization roles are per-scope and
 * resolved by the hook"*. This is the hook. A grant on an organization-scoped role would have been
 * unreachable for every caller if the membership's `roleKey` were not added — and `permits` would
 * have refused, correctly, on input that was simply incomplete. That failure looks like policy,
 * which is what makes it worth its own test.
 */
describe('organization roles come from the membership', () => {
    it('adds the roleKey of the organization this request resolved to', async () => {
        const { asked, hook } = harness({
            memberships: [{ organizationId: 'org-1', roleKey: 'owner' }],
            grants: [{ role: 'owner', contract: 'card.update' }],
        });

        const answer = await hook(ask('card.update'));

        expect(answer.authorized).toBe(true);
        const permitsCall = asked.find((a) => a.tool === 'identity.permits');
        expect(permitsCall?.params['roles']).toEqual(['owner']);
        expect(permitsCall?.params['organizationId']).toBe('org-1');
    });

    it('uses the role held *here*, not one held in another organization', async () => {
        // Owner of one, viewer of another. On the second organization's site they are a viewer, and
        // a grant on `owner` must not follow them across.
        const { asked, hook } = harness({
            memberships: [
                { organizationId: 'org-1', roleKey: 'owner' },
                { organizationId: 'org-2', roleKey: 'viewer' },
            ],
            grants: [{ role: 'owner', contract: 'card.update' }],
        });

        const answer = await hook(ask('card.update', { siteScope: 'org-2' }));

        expect(answer.authorized).toBe(false);
        expect(asked.find((a) => a.tool === 'identity.permits')?.params['roles']).toEqual(['viewer']);
    });
});

describe('it fails closed', () => {
    it('refuses when identity.permits answers something malformed', async () => {
        // "I could not tell" must never read as "yes". Not `!permitted` — an absent field, a string,
        // a null, all land here.
        for (const answer of [undefined, {}, { permitted: 'yes' }, null, { ok: true }]) {
            const { hook } = harness({
                memberships: [{ organizationId: 'org-1' }],
                permitsAnswers: answer,
            });

            const outcome = await hook(ask('card.update'));
            expect(outcome.authorized, `answer ${JSON.stringify(answer)}`).toBe(false);
        }
    });

    it('lets an identity outage throw rather than reporting it as a refusal', async () => {
        // A 403 would send somebody looking for a missing grant that exists. An error is not an
        // authorization decision, and dressing it as one hides the outage.
        const hook = membershipAuthorize(async (tool: string) => {
            if (tool === 'identity.whoami') return { organizations: [{ organizationId: 'org-1' }] };
            throw new Error('identity is down');
        });

        await expect(hook(ask('card.update'))).rejects.toThrow('identity is down');
    });

    it('refuses on scope before asking what the caller holds', async () => {
        // A caller who may not act in the organization they asked for is refused for that reason.
        // Asking the second question first would answer it against the wrong organization.
        const { asked, hook } = harness({
            memberships: [{ organizationId: 'org-1', roleKey: 'owner' }],
            grants: [{ role: 'owner', contract: 'card.update' }],
        });

        const answer = await hook(ask('card.update', { requestedScope: 'org-nope' }));

        expect(answer.authorized).toBe(false);
        expect(answer.authorized === false && answer.status).toBe(404);
        expect(asked.some((a) => a.tool === 'identity.permits')).toBe(false);
    });
});
