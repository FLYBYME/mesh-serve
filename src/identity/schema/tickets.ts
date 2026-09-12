/**
 * Tickets: a bearer credential that is a row, not a signed claim.
 *
 * `spec/identity.md` §9. **It is a row precisely so it can be withdrawn.** A signed token the server
 * cannot take back is a credential whose lifetime is decided by whoever holds it.
 */

import { randomBytes } from 'node:crypto';

import { z } from '@flybyme/mesh';

/** Twelve hours. Long enough not to be a nuisance, short enough that an unnoticed leak expires. */
export const DEFAULT_TICKET_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** 256 bits from a CSPRNG. Never derived from anything about the account. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

export const TicketSchema = z.object({
    token: z.string().min(1).describe('The credential itself. Unique, opaque'),
    userId: z.string().min(1),
    roles: z.array(z.string()).default([]),
    issuedAt: z.number(),
    expiresAt: z.number(),

    /** Recorded for an audit trail. Does not change what is granted. */
    via: z.string().default('password'),

    revokedAt: z.number().optional(),
    revokedReason: z.string().optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;

/**
 * What `ticket_validate` answers.
 *
 * **Deliberately not the ticket row.** A validator is told who the caller is and nothing about the
 * credential itself, so a positive answer cannot be replayed as one.
 */
export const ValidationSchema = z.object({
    valid: z.boolean(),
    userId: z.string().optional(),
    roles: z.array(z.string()).optional(),
    expiresAt: z.number().optional(),
    /** So a client can say *claim this account* rather than *something went wrong*. */
    provisional: z.boolean().optional(),
});

export type Validation = z.infer<typeof ValidationSchema>;

/**
 * Live means issued, not revoked, and not expired — checked in that order and in one place.
 *
 * Three call sites needed this and two of them checked two of the three. A predicate with a name is
 * the difference between a rule and a convention.
 */
export const isLive = (ticket: Ticket, now: number): boolean =>
    ticket.revokedAt === undefined && ticket.expiresAt > now;
