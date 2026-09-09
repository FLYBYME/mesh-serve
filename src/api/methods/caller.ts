/**
 * **Who is calling — one answer, for every door.**
 *
 * A credential arrives on `Authorization: Bearer …` and is one of two things: a **ticket**, which
 * belongs to somebody who typed a password, or an **API token**, which was issued to a program. The
 * difference is load-bearing — `McpService` refuses a `destructive` contract to a token and parks it
 * for approval, precisely because *a destructive write asks a person* and a token cannot be asked.
 *
 * It lived in `McpService` and nowhere else, which made that distinction true of exactly one door
 * (roadmap D10). `ApiService` resolved tickets only, so **the same token authenticated over MCP and
 * was anonymous over HTTP** — and the CLI is an HTTP client, so it could not use the credential the
 * platform issues to programs. Two entry paths over one exposure, drifting.
 *
 * Anonymous is a real answer and never an error. The gate decides whether anonymous is good enough,
 * and a `public` contract is reachable without either credential. An expired token reads the same as
 * no token, which is something a client can act on.
 */

import type { Caller } from './gate.js';
import type { TicketCache } from './tickets.js';

export interface ResolveOptions {
    readonly tickets?: TicketCache;
    /**
     * How to reach `identity.api_token_validate`.
     *
     * A function rather than a broker, so this file knows nothing about how a call is made and both
     * services hand it their own narrow retype. It is also what lets a test resolve a token without
     * a mesh.
     */
    readonly call?: (tool: string, params: unknown, options: { meta: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Ticket first, then token.
 *
 * That order is not arbitrary: a ticket resolves from a cache in memory and a token costs a broker
 * round trip, so the common case pays nothing. Two lookups on a miss is the cost. A prefixed token
 * (`mst_…`) would let this route on sight rather than by trying; worth doing when tokens are next
 * touched, and not worth a migration on its own.
 */
export async function resolveCaller(
    credential: string | undefined,
    options: ResolveOptions,
): Promise<Caller | undefined> {
    if (credential === undefined || credential === '') return undefined;

    const asTicket = await options.tickets?.resolve(credential);
    if (asTicket !== undefined) return asTicket;

    if (options.call === undefined) return undefined;

    try {
        const answer = await options.call(
            'identity.api_token_validate',
            { token: credential },
            { meta: { unauthenticated: true } },
        ) as { valid?: boolean; userId?: string; roles?: string[]; name?: string };

        if (answer.valid !== true || answer.userId === undefined) return undefined;

        return {
            userId: answer.userId,
            roles: answer.roles ?? [],
            /**
             * Named, so a refusal, an approval record and an audit line can all say *which* agent.
             *
             * A token with no name is still an agent: the fallback is a label, never an absence.
             * `agent === undefined` is how every caller of this asks *is this a person*, so leaving
             * it unset for an unnamed token would quietly promote a program to one.
             */
            agent: answer.name ?? 'an api token',
        };
    } catch {
        // A token this cluster cannot validate is not a caller. Anonymous, not an error.
        return undefined;
    }
}
