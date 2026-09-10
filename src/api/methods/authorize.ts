/**
 * **The hook without which every scoped collection is unreachable over HTTP.**
 *
 * The coarse gate resolves *who is asking* and stops there; `api.service.ts` says why it must —
 * *"only the site knows what an organization means to it"*. This turns that caller into the
 * **scope** the request runs in, which becomes `meta.user.tenant_id` and confines every `scopedBy`
 * collection. With no hook the resolved scope is always empty, so `site.find` answers 401 to a
 * correctly signed-in caller while `part.find` answers 200, because that one is not scoped.
 *
 * ## Why it is here and not in `bin/node.mjs`
 *
 * It was four lines in the launcher, and F22 moved the *rule* out of them into `scope.ts` — where
 * the case of a caller in several organizations could finally be tested, having never been run
 * before the first two-tenant cluster. What stayed behind was the fetch, which is small and is also
 * the part that decides *what counts as a membership*.
 *
 * Left there it is unreachable by any test in this repository and un-shareable by any second
 * launcher, so the only integration test that could exercise a scoped read over HTTP would have to
 * write its own copy of it — and a test that asserts against its own copy of the thing under test
 * asserts nothing. That is the same shape as F25, where a test asserted the broken value.
 *
 * **A caller-supplied organization is a request, never a grant.** `resolveScope` checks membership
 * before honouring the header and refuses rather than falling back to a different organization:
 * silently acting in the wrong scope is the failure that matters.
 */

import { resolveScope } from './scope.js';
import type { AuthorizeHook, AuthorizeResult } from './gate.js';

/**
 * What `identity.whoami` answers, narrowed to what this needs.
 *
 * `roleKey` is the **organization** role, and it is here because `Caller.roles` deliberately is not:
 * *"Platform-level roles. Organization roles are per-scope and resolved by the hook"* (`gate.ts:60`).
 * This is the hook, and until F30 nothing resolved them.
 */
interface Whoami {
    readonly organizations?: readonly {
        readonly organizationId: string;
        readonly roleKey?: string;
    }[];
}

/** What `identity.permits` answers. Narrow, and read defensively — see `refuse` below. */
interface Permission {
    readonly permitted?: boolean;
}

/**
 * Build the hook from whatever can make a broker call — a `MeshApp`, a broker, a test's own
 * wrapper. Taking the call rather than the app is what lets this be tested at all.
 */
export function membershipAuthorize(
    call: (tool: string, params: unknown, options: { meta: unknown }) => Promise<unknown>,
): AuthorizeHook {
    return async ({ caller, requestedScope, siteScope, permission }) => {
        // Anonymous callers resolve no scope and are refused by the coarse gate or by the
        // collection, whichever comes first. Not this hook's decision.
        //
        // A `permission` gate never reaches here anonymous: `checkCoarse` refuses an absent caller
        // on every gate kind but `public`, which is why this can return before asking identity.
        if (caller === undefined) return { authorized: true };

        const me = await call('identity.whoami', {}, {
            meta: { user: { id: caller.userId } },
        }) as Whoami | undefined;
        const memberships = me?.organizations ?? [];

        const scope = resolveScope({ memberships, requestedScope, siteScope });

        // **Scope first, and it short-circuits.** A caller who may not act in the organization they
        // asked for is refused for that reason, before any question about what they hold there — and
        // asking the second question first would answer it against the wrong organization.
        if (!scope.authorized) return scope;
        if (permission === undefined) return scope;

        return permits(call, caller, memberships, permission, scope);
    };
}

/**
 * **Does this caller hold a role granting this permission, here?**
 *
 * The API asks; identity decides — `identity.permits`' own comment says why: *"the answer depends on
 * grant records, which live here … that keeps the whole of 'what is a role' in one module, which is
 * what lets a deployment define `author` and `compliance` without either the API or the framework
 * knowing those words."*
 *
 * **Roadmap F30.** Until this existed, a `permission` gate was evaluated by nobody. `executeGate`
 * passed the key to the hook, the hook read three fields and never that one, and the answer was
 * whatever `resolveScope` said — so `permission: 'dns.write'` admitted exactly the callers
 * `auth: 'user'` would have. The whole role-and-grant model in `identity/schema/roles.ts` — records
 * rather than an enum, grants as rows, patterns, cluster vs organization scope, deny by default —
 * was reachable from a unit test and from nothing else.
 */
async function permits(
    call: (tool: string, params: unknown, options: { meta: unknown }) => Promise<unknown>,
    caller: { readonly userId: string; readonly roles: readonly string[] },
    memberships: NonNullable<Whoami['organizations']>,
    permission: string,
    scope: { readonly authorized: true; readonly resolvedScope?: string },
): Promise<AuthorizeResult> {
    const organizationId = scope.resolvedScope;

    /**
     * **Two sets of roles, and using only one of them is the bug this is written to avoid.**
     *
     * A principal's `roles` are cluster standing — `operator`, and whatever else the deployment
     * grants everywhere. An **organization** role lives on the membership (`principals.ts`: *"they
     * are a fact about a person's place in an organization, not about the deployment"*), so a role
     * scoped to an organization can only be found by looking at the membership for the organization
     * this request resolved to. Passing cluster roles alone would make every organization-scoped
     * grant unreachable, which is `permits`' scope check refusing correctly on incomplete input —
     * the worst kind of wrong answer, because it looks like policy.
     */
    const membershipRole = organizationId === undefined
        ? undefined
        // The membership for the organization this request resolved to, and no other: a caller who
        // is `owner` of one organization and `viewer` of another must be a viewer here.
        : memberships.find((m) => m.organizationId === organizationId)?.roleKey;

    const roles = membershipRole === undefined
        ? [...caller.roles]
        : [...caller.roles, membershipRole];

    const answer = await call('identity.permits', {
        roles,
        contract: permission,
        organizationId,
    }, { meta: { user: { id: caller.userId } } }) as Permission | undefined;

    /**
     * **Anything but an explicit yes is a refusal.** Not `!answer.permitted`: a malformed answer, an
     * absent one, or a field of the wrong type all land here, and the one thing an authorization
     * check must never do is read *"I could not tell"* as *"yes"*. A thrown call propagates rather
     * than being caught — identity being unreachable is an outage, and reporting it as a 403 would
     * send somebody looking for a missing grant that exists.
     */
    if (answer?.permitted !== true) {
        return {
            authorized: false,
            status: 403,
            code: 'FORBIDDEN',
            message: `You hold no role granting '${permission}'.`,
        };
    }

    return scope;
}
