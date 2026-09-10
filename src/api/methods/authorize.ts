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
import type { AuthorizeHook } from './gate.js';

/** What `identity.whoami` answers, narrowed to the one field this needs. */
interface Whoami {
    readonly organizations?: readonly { readonly organizationId: string }[];
}

/**
 * Build the hook from whatever can make a broker call — a `MeshApp`, a broker, a test's own
 * wrapper. Taking the call rather than the app is what lets this be tested at all.
 */
export function membershipAuthorize(
    call: (tool: string, params: unknown, options: { meta: unknown }) => Promise<unknown>,
): AuthorizeHook {
    return async ({ caller, requestedScope, siteScope }) => {
        // Anonymous callers resolve no scope and are refused by the coarse gate or by the
        // collection, whichever comes first. Not this hook's decision.
        if (caller === undefined) return { authorized: true };

        const me = await call('identity.whoami', {}, {
            meta: { user: { id: caller.userId } },
        }) as Whoami | undefined;

        return resolveScope({
            memberships: me?.organizations ?? [],
            requestedScope,
            siteScope,
        });
    };
}
