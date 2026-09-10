/**
 * **Which organization a request runs in, and what to say when nothing can decide.**
 *
 * The answer becomes `meta.user.tenant_id` (and `organizationId`, see `callerMeta`), and every
 * `scopedBy` collection is confined by it. So this is where a caller in several organizations either
 * gets a scope or gets none — and *none* used to mean every scoped read failed.
 *
 * ## The site decides among the caller's own memberships (roadmap F22)
 *
 * A caller in exactly one organization needs no header: there is nothing to choose. A caller in
 * several was left with no scope unless they sent `x-organization`, which no part and no CLI could
 * send. The operator became that person the moment a second tenant was seeded — seeding makes the
 * caller the owner — and from then on the console answered every read with
 *
 *     401  Scoped collection "site" requires a resolved "tenantId" scope
 *
 * and rendered it as *"You need to sign in"*, to somebody who was signed in.
 *
 * **Every request arrives on a hostname, and that hostname's site belongs to an organization.** If
 * the caller is a member of it, that is what they mean: `console.localhost` is Platform's,
 * `flowboard.localhost` is Flowboard Inc's. The site *chooses among* the caller's memberships and
 * cannot add to them, so this widens nothing — a caller who is not a member of the site's
 * organization gets exactly what they got before. An explicit header still wins, and is still
 * checked against the caller's memberships rather than trusted.
 *
 * Pure, and outside `bin/node.mjs`, so it can be tested. It used to be written inline in the node's
 * startup script, which is why the case above had never been exercised by anything.
 */

import { SCOPE_HEADER } from './gate.js';

export interface ScopeQuestion {
    /** The caller's own memberships, from identity. Never from the request. */
    readonly memberships: readonly { readonly organizationId: string }[];
    /** What the caller asked for with `x-organization`. A request, not a grant. */
    readonly requestedScope: string | undefined;
    /** The organization owning the site the request arrived on. */
    readonly siteScope: string | undefined;
}

export type ScopeAnswer =
    | { readonly authorized: true; readonly resolvedScope?: string }
    | { readonly authorized: false; readonly status: 404; readonly code: string; readonly message: string };

export function resolveScope(question: ScopeQuestion): ScopeAnswer {
    const { memberships, requestedScope, siteScope } = question;
    const isMember = (id: string): boolean => memberships.some((m) => m.organizationId === id);

    if (requestedScope !== undefined) {
        return isMember(requestedScope)
            ? { authorized: true, resolvedScope: requestedScope }
            // 404, not 403: whether an organization exists is not something an unrelated caller gets
            // to confirm by probing.
            : { authorized: false, status: 404, code: 'no_such_organization', message: 'No such organization.' };
    }

    const only = memberships.length === 1 ? memberships[0] : undefined;
    if (only !== undefined) return { authorized: true, resolvedScope: only.organizationId };

    if (siteScope !== undefined && isMember(siteScope)) {
        return { authorized: true, resolvedScope: siteScope };
    }

    // Several memberships and none is this site's, or none at all. Guessing which is how a request
    // reads the wrong organization's data, so the scope stays unset and a scoped read says so.
    return { authorized: true };
}

/**
 * **The refusal a scoped read makes when no scope was resolved — recognised, so it can be re-worded.**
 *
 * mesh raises it deep in its database middleware as `UNAUTHORIZED` / 401, and mesh is frozen. To a
 * caller who presented a valid ticket that status is wrong in the way that matters most: a browser's
 * transport maps 401 to *"You need to sign in"*, and the person is signed in.
 *
 * Matched on the message because that is all a frozen framework offers. The pattern is the one mesh
 * writes (`DatabaseMiddleware.ts`) and a test pins it.
 */
const UNRESOLVED_SCOPE = /requires a resolved "[^"]+" scope/;

export function isUnresolvedScope(error: unknown): boolean {
    return error instanceof Error && UNRESOLVED_SCOPE.test(error.message);
}

/**
 * What a signed-in caller is told instead. It names both causes, because the api cannot tell them
 * apart without another lookup: an account in no organization, and one in several that did not say.
 */
export const ORGANIZATION_REQUIRED = {
    status: 400 as const,
    code: 'ORGANIZATION_REQUIRED',
    message: 'This needs an organization, and none could be chosen: this account belongs to none, '
        + `or to several and the request did not say which. Name one with the ${SCOPE_HEADER} header.`,
};
