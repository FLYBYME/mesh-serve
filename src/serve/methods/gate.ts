/**
 * The gate: may this caller make this call, and in whose scope.
 *
 * **This is the part that must be right.** Everything else in this package is plumbing; the API is
 * the only security boundary in the system.
 *
 * Pure functions over data, deliberately. The previous gate was reachable only through a running
 * HTTP server with a database behind it, so the cases below were never exercised directly — and one
 * of them was wrong for months.
 */

import type { Gate } from '../schema/site.js';
import { refuse, type ErrorResponse } from './errors.js';

/** Chooses among the caller's own memberships. A request, never a grant. */
export const SCOPE_HEADER = 'x-organization';

/**
 * The one action a provisional account may reach.
 *
 * Named here rather than in a list of exceptions, because a list is a thing that grows.
 */
export const PASSWORD_ACTION = 'identity.set_password';

/** Who is calling, as established by the ticket. Never taken from the request body. */
export interface Caller {
    readonly userId: string;
    readonly roles: readonly string[];
    /**
     * Created by the platform on first boot and not yet claimed by a person. Refused everywhere
     * except `PASSWORD_ACTION`.
     */
    readonly provisional?: boolean;
    /**
     * **The API token this caller arrived on, by name — so an agent is not mistaken for a person.**
     *
     * A ticket is issued to somebody who typed a password. A token is issued *to a program*, and the
     * two must not be the same kind of caller even when they resolve to the same account: a
     * destructive contract asks a person to confirm and there is nobody to ask on a token, and an
     * audit line saying *"tim deleted the release"* when tim's agent did is a lie that reads as fact.
     *
     * **Its absence means a person**, which is the safe direction: a new credential kind that forgot
     * to set it is treated as more suspicious rather than less.
     */
    readonly agent?: string;
}

export interface GateRequest {
    /** `domain.action`, for the provisional check and for anything that reads a name. */
    readonly key: string;
    readonly gate: Gate;
    readonly caller: Caller | undefined;
    /** The caller's own memberships, from identity. Never from the request. */
    readonly memberships: readonly { readonly organizationId: string }[];
    /** What the caller asked for with the scope header. A request, not a grant. */
    readonly requestedScope: string | undefined;
    /** The organization owning the site this request arrived on. */
    readonly siteScope: string | undefined;
}

export type GateOutcome =
    | { readonly allowed: true; readonly resolvedScope: string | undefined }
    | { readonly allowed: false; readonly response: ErrorResponse };

/**
 * The coarse gate, then the scope.
 *
 * **The order matters and it is not arbitrary.** A provisional account is refused ahead of every
 * other check, so no contract can forget; the level or permission is next; the scope is resolved
 * last, because it is the only step that can succeed while producing nothing.
 *
 * There is no hook parameter. The previous gate took one, and supplying it **replaced** the coarse
 * check rather than adding to it:
 *
 *     if (authorize) { ...delegate entirely... } else { checkAuth(entry.auth) }
 *
 * so a hook returning *no objection from me* granted everything. **A security boundary that can be
 * switched off by returning `true` from the wrong place is not a boundary.** When a hook comes back
 * it runs after this and may only narrow.
 */
export function gate(request: GateRequest): GateOutcome {
    const coarse = checkCoarse(request);
    if (coarse !== undefined) return { allowed: false, response: coarse };

    return resolveScope(request);
}

function checkCoarse(request: GateRequest): ErrorResponse | undefined {
    const { gate: entry, caller, key } = request;

    /**
     * **Public is public, whoever is asking — and this answers `spec/questions.md` E3.**
     *
     * The first draft made this branch conditional on there being no caller, which put the
     * provisional check in front of every public contract. E3 describes the resulting shape as an
     * oddity: a site's description readable with no credential, readable with a *garbage* one, and
     * refused with a real provisional one.
     *
     * It is worse than odd. `identity.sign_out` is public, so **an unclaimed account could not sign
     * out**, and `identity.ticket_issue` is public, so it could not sign in again either. A
     * restriction that means *do nothing until you set a password* must not also mean *and you may
     * not use the door you came in through*.
     *
     * Found by a test written to assert the ordering, which is the only reason it is not in the
     * first release.
     */
    if (entry.kind === 'auth' && entry.level === 'public') return undefined;

    if (caller === undefined) return refuse('UNAUTHENTICATED');

    /**
     * **A provisional account may do exactly one thing.**
     *
     * After the public case, and before everything else so nothing downstream has to remember.
     */
    if (caller.provisional === true && key !== PASSWORD_ACTION) {
        return refuse('PROVISIONAL_ACCOUNT');
    }

    if (entry.kind === 'auth') {
        // `public` and `user` are both satisfied by there being a caller at all. `admin` and
        // `operator` are roles until C1 lands, at which point this branch goes away entirely.
        if (entry.level === 'public' || entry.level === 'user') return undefined;
        return caller.roles.includes(entry.level) ? undefined : refuse('FORBIDDEN');
    }

    return caller.roles.includes(entry.permission) ? undefined : refuse('FORBIDDEN');
}

/**
 * Which organization this request runs in.
 *
 * `spec/identity.md` §8, and the six cases there are the six branches here. The resolved value
 * becomes `meta.user.tenant_id`, and every scoped collection is confined by it.
 *
 * **The gate returns the scope. A request never supplies one.**
 */
function resolveScope(request: GateRequest): GateOutcome {
    const { memberships, requestedScope, siteScope } = request;
    const isMember = (id: string): boolean => memberships.some((m) => m.organizationId === id);

    // 1 and 2. An explicit selection narrows; it cannot add.
    if (requestedScope !== undefined) {
        if (isMember(requestedScope)) return { allowed: true, resolvedScope: requestedScope };
        /**
         * **404, not 403.** Whether an organization exists is not something an unrelated caller gets
         * to confirm by probing.
         */
        return {
            allowed: false,
            response: { status: 404, body: { error: 'NO_SUCH_ORGANIZATION', message: 'No such organization.' } },
        };
    }

    // 3. One membership: there is nothing to choose.
    const only = memberships.length === 1 ? memberships[0] : undefined;
    if (only !== undefined) return { allowed: true, resolvedScope: only.organizationId };

    /**
     * 4. Several, and this hostname belongs to one of them.
     *
     * **Every request arrives on a hostname, and that hostname's site belongs to an organization.**
     * The site chooses *among* the caller's memberships and cannot add to them, so this widens
     * nothing — a caller who is not a member gets exactly what they got before.
     *
     * It exists because the operator becomes a member of every tenant the moment they seed one, and
     * from then on every scoped read answered *"requires a resolved scope"*, which a browser renders
     * as *"You need to sign in"*, to somebody who was signed in.
     */
    if (siteScope !== undefined && isMember(siteScope)) {
        return { allowed: true, resolvedScope: siteScope };
    }

    /**
     * 5 and 6. Several and none is this site's, or none at all.
     *
     * **No scope, and allowed.** Guessing which organization was meant is how a request reads the
     * wrong tenant's data. An unscoped collection is still readable; a scoped one refuses, and says
     * which of the two causes it was — the gate cannot tell them apart without another lookup.
     */
    return { allowed: true, resolvedScope: undefined };
}
