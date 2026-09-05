/**
 * What identity answers over the mesh.
 *
 * Every one of these is `internal` by default and **that is deliberate**. mesh defaults a contract
 * to internal, and identity is the module a deployment authenticates through: `ticket_validate` on
 * the public internet would let anyone test tickets against it, and `revocations_since` would leak
 * who had been suspended and when.
 *
 * Two are marked `public` because a site genuinely has to expose them — registering and asking who
 * you are — and even then it is the *site's* exposure list that decides, not this file
 * (mesh-web spec/service-modules.md §2, C3.2).
 */

import { defineContract, z } from '@flybyme/mesh';

import { ValidationSchema } from '../schema/tickets.js';

// ---------------------------------------------------------------------------- tickets

export const ticketIssueContract = defineContract({
    domain: 'identity',
    action: 'ticket_issue',
    description: 'Exchange credentials for an opaque ticket.',
    inputSchema: z.object({
        email: z.string().email(),
        password: z.string().min(1),
        /** Recorded on the ticket for an audit trail; does not change what is granted. */
        via: z.string().optional(),
    }),
    outputSchema: z.object({
        token: z.string(),
        userId: z.string(),
        expiresAt: z.number(),
    }),
    rest: { method: 'POST', path: '/identity/ticket' },
    // Public, because signing in is the one call that cannot require being signed in. Found by the
    // first site to expose this domain (mesh-web A6.7): `describeExposure` refused the entry, which
    // is the check working — an internal contract must never reach the internet by accident — but
    // the answer here is that this contract was never internal. `register` and `whoami` beside it
    // already said so; this one was missed.
    visibility: 'public',
    destructive: true,
    print: (o) => `ticket for ${o.userId}`,
});

export const ticketValidateContract = defineContract({
    domain: 'identity',
    action: 'ticket_validate',
    description: 'Is this ticket valid, and whose is it.',
    inputSchema: z.object({ ticket: z.string().min(1) }),
    outputSchema: ValidationSchema,
    rest: { method: 'POST', path: '/identity/ticket/validate' },
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export const ticketRevokeContract = defineContract({
    domain: 'identity',
    action: 'ticket_revoke',
    description: 'Revoke one ticket, or every ticket a principal holds.',
    inputSchema: z.object({
        /** One of these. A ticket, or everything belonging to a user. */
        token: z.string().optional(),
        userId: z.string().optional(),
        reason: z.string().optional(),
    }),
    outputSchema: z.object({
        revoked: z.number().describe('How many tickets this ended'),
        epoch: z.number().describe('The epoch to poll from to see it'),
    }),
    rest: { method: 'POST', path: '/identity/ticket/revoke' },
    destructive: true,
    print: (o) => `revoked ${String(o.revoked)} at epoch ${String(o.epoch)}`,
});

/**
 * What changed since an API instance last looked.
 *
 * **The contract that makes revocation correct** rather than likely. mesh-web spec/auth.md §3.1: the
 * mesh delivers events at-most-once, so an instance that was down when a ticket was revoked never
 * hears about it. A poll cannot be missed, only delayed.
 *
 * The event `identity.ticket_revoked` still fires, and an instance still listens — that is what
 * makes the common case immediate. This is what makes it *right*.
 */
export const revocationsSinceContract = defineContract({
    domain: 'identity',
    action: 'revocations_since',
    description: 'Revocations after a given epoch, for an API instance catching up.',
    inputSchema: z.object({
        epoch: z.number().describe('The last epoch this caller has seen. 0 for everything retained.'),
        limit: z.number().optional(),
    }),
    outputSchema: z.object({
        epoch: z.number().describe('The newest epoch, to poll from next time'),
        revocations: z.array(z.object({
            epoch: z.number(),
            kind: z.enum(['ticket', 'principal']),
            subject: z.string(),
            at: z.number(),
        })),
        /**
         * True when the caller's epoch is older than anything retained.
         *
         * It cannot be told what it missed, so it must not pretend to be current: the honest
         * response is for it to drop its cache and re-validate, which is the one case where §3's
         * original "drop everything on reconnect" is still the right answer.
         */
        truncated: z.boolean(),
    }),
    rest: { method: 'GET', path: '/identity/revocations' },
    print: (o) => `${String(o.revocations.length)} revocations up to epoch ${String(o.epoch)}`,
});

// ---------------------------------------------------------------------------- principals

export const whoamiContract = defineContract({
    domain: 'identity',
    action: 'whoami',
    description: 'Who the caller is, and which organizations they belong to.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        userId: z.string(),
        email: z.string(),
        displayName: z.string(),
        roles: z.array(z.string()),
        organizations: z.array(z.object({
            organizationId: z.string(),
            name: z.string(),
            roleKey: z.string(),
        })),
    }),
    rest: { method: 'GET', path: '/identity/whoami' },
    visibility: 'public',
    print: (o) => `${o.displayName} <${o.email}>`,
});

export const registerContract = defineContract({
    domain: 'identity',
    action: 'register',
    description: 'Create an account.',
    inputSchema: z.object({
        email: z.string().email(),
        password: z.string().min(8),
        displayName: z.string().min(1),
    }),
    outputSchema: z.object({ userId: z.string() }),
    rest: { method: 'POST', path: '/identity/register' },
    visibility: 'public',
    destructive: true,
    print: (o) => `registered ${o.userId}`,
});

// ---------------------------------------------------------------------------- authorization

/**
 * May a caller holding these roles call this contract?
 *
 * Here rather than in the API because the answer depends on grant *records*, which live here. The
 * API asks; identity decides. That keeps the whole of "what is a role" in one module, which is what
 * lets a deployment define `author` and `compliance` without either the API or the framework
 * knowing those words.
 */
export const permitsContract = defineContract({
    domain: 'identity',
    action: 'permits',
    description: 'Whether a caller holding these roles may call a contract.',
    inputSchema: z.object({
        roles: z.array(z.string()),
        contract: z.string().min(1),
    }),
    outputSchema: z.object({ permitted: z.boolean() }),
    rest: { method: 'POST', path: '/identity/permits' },
    print: (o) => (o.permitted ? 'permitted' : 'denied'),
});

export const identityContracts = [
    ticketIssueContract,
    ticketValidateContract,
    ticketRevokeContract,
    revocationsSinceContract,
    whoamiContract,
    registerContract,
    permitsContract,
] as const;
