/**
 * Tickets, and the revocation epoch that makes revoking one actually work.
 *
 * mesh-web spec/auth.md §1, §3 and **§3.1**.
 *
 * ## Opaque, which is the whole point
 *
 * A ticket is a random string. Nothing verifies it by signature, so **there is no signing key** —
 * none to distribute to ten API instances, none to rotate, none to leak. That was the largest open
 * item in an earlier draft of the design and it disappears rather than being solved. The cost is
 * that validating one is a mesh call, which the API's ticket cache already makes cheap: one call per
 * (ticket, instance), not per request.
 *
 * ## Why there is an epoch
 *
 * auth §3 assumed revocation could ride on an event. §3.1 records what `mesh` actually does:
 * `TCPTransport.publish` writes to peers connected and authenticated *at that instant*, with no
 * acknowledgement, retry, queue or persistence. At-most-once. An API instance that was down or
 * partitioned when a ticket was revoked never learns about it.
 *
 * So revocation cannot be event-driven and correct at the same time, and the fix is **pull for
 * correctness, push for latency**:
 *
 * - identity keeps a monotonic `epoch` and a row per revocation
 * - an API instance polls `revocations_since(epoch)` on an interval and on every reconnect
 * - it *also* listens for the event, which makes the common case immediate
 *
 * A poll cannot be missed, only delayed. That is a guarantee the transport does not have to provide,
 * and it survives disconnection, restart and partition — none of which the event does.
 */

import { z } from 'zod';

export const TicketSchema = z.object({
    /**
     * The bearer token itself, opaque and random.
     *
     * Stored so it can be looked up and revoked. A deployment that would rather not hold them can
     * store a hash instead — the design does not depend on the value being recoverable, only on it
     * being *comparable*, and nothing here ever sends it back out.
     */
    token: z.string().min(1),
    userId: z.string().min(1),
    /** Cluster-scoped roles the holder had when it was issued. Organization roles come from membership. */
    roles: z.array(z.string()).default([]),
    issuedAt: z.number(),
    /**
     * When it stops being valid regardless of anything else.
     *
     * The API caches a validation, and §3 requires a cache entry never outlive its ticket — so this
     * travels with the answer rather than being something the API has to guess.
     */
    expiresAt: z.number(),
    /** How it was obtained, for an audit trail: `password`, `passkey`, `apiToken`. */
    via: z.string().default('password'),
    /** Present once revoked. A revoked ticket is kept, not deleted — see `revocations`. */
    revokedAt: z.number().optional(),
    revokedReason: z.string().optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;

/**
 * One revocation, at one epoch.
 *
 * A row rather than a flag on the ticket, and the difference matters: an API instance asks *what
 * changed since epoch N*, which a flag cannot answer. Kept until every plausible poller has passed
 * that epoch — a revocation older than the longest ticket lifetime can be pruned, because a ticket
 * that old is expired anyway.
 */
export const RevocationSchema = z.object({
    /** Monotonic. The cursor an API instance holds between polls. */
    epoch: z.number(),
    /** What was revoked. A single ticket, or everything belonging to a principal. */
    kind: z.enum(['ticket', 'principal']),
    /** The token, or the userId, depending on `kind`. */
    subject: z.string().min(1),
    at: z.number(),
    reason: z.string().optional(),
});

export type Revocation = z.infer<typeof RevocationSchema>;

/** What `identity.ticket_validate` answers. Shaped for the API's cache, which is its only caller. */
export const ValidationSchema = z.object({
    valid: z.boolean(),
    userId: z.string().optional(),
    roles: z.array(z.string()).optional(),
    /** So the API's cache entry cannot outlive the ticket, whatever its own TTL says. */
    expiresAt: z.number().optional(),
    /**
     * The epoch this answer was correct at.
     *
     * A validating instance that has never polled gets a cursor for free, so its first
     * `revocations_since` asks about the right window rather than the whole history.
     */
    epoch: z.number(),
});

export type Validation = z.infer<typeof ValidationSchema>;

/** How long a ticket lives unless something ends it sooner. */
export const DEFAULT_TICKET_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * A ticket, generated.
 *
 * `crypto.randomUUID` twice rather than once: a UUID is 122 bits of randomness, and a bearer token
 * that is guessable is the one failure mode this design has no second line of defence against —
 * there is no signature to also forge.
 */
export function mintToken(random: () => string = () => crypto.randomUUID()): string {
    return `${random()}${random()}`.replace(/-/g, '');
}

/** Is this ticket usable right now, ignoring revocations the caller may not have seen? */
export function isLive(ticket: Ticket, now = Date.now()): boolean {
    return ticket.revokedAt === undefined && ticket.expiresAt > now;
}
