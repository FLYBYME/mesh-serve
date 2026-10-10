import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { RenewInput, RenewOutput } from '../contracts/ticket.contract.js';
import { hashToken, issuedToken } from '../methods/hash.js';
import { TICKET_TTL_MS } from './issueTicket.js';

/** How long after the password was last given a ticket may still be renewed. */
export const RENEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * identity.ticket.renew (contract: ticket.contract.ts) -- a valid ticket exchanged for a fresh one.
 *
 * The new ticket keeps the old one's sign-in time, so the 30 days run from the password, never from
 * the last renewal; and it never runs past them. The old ticket is revoked before the new one is
 * returned: only one of the two works, ever. The holder's roles are read again, as at sign-in.
 */
export async function renew(input: RenewInput, ctx: IServiceContext): Promise<RenewOutput> {
    const tickets = ctx.db('identity.ticket');
    const now = new Date();

    const ticket = await tickets.findOne({ query: { token: hashToken(input.token) } });
    if (ticket === undefined || ticket.revokedAt !== undefined || ticket.expiresAt.getTime() <= now.getTime()) {
        throw new MeshError({ message: 'This sign-in has ended: sign in again.', code: 'TICKET_INVALID', status: 401 });
    }

    const signedInAt = ticket.signedInAt ?? ticket.issuedAt;
    const renewableUntil = signedInAt.getTime() + RENEW_FOR_MS;
    if (renewableUntil <= now.getTime()) {
        throw new MeshError({ message: 'It has been 30 days since you signed in: sign in again.', code: 'SIGN_IN_AGAIN', status: 401 });
    }

    const user = await ctx.db('identity.user').resolve({ id: ticket.userId });
    if (user === undefined) {
        throw new MeshError({ message: 'This sign-in has ended: sign in again.', code: 'TICKET_INVALID', status: 401 });
    }
    if (user.suspendedAt !== undefined) {
        throw new MeshError({ message: user.suspendedReason ?? 'Account suspended.', code: 'SUSPENDED', status: 403 });
    }

    // The old one stops first: a failure after this leaves the holder to sign in, never two tickets.
    await tickets.update({ id: ticket.id, revokedAt: now, revokedReason: 'renewed' });

    const token = issuedToken();
    const expiresAt = new Date(Math.min(now.getTime() + TICKET_TTL_MS, renewableUntil));
    await tickets.create({
        token: hashToken(token),
        userId: user.id,
        roles: user.roles,
        issuedAt: now,
        signedInAt,
        expiresAt,
        via: 'renew',
    });

    // Never the ticket itself: it is a bearer credential.
    ctx.logger.debug(`renewed a ticket for "${user.id}"`, { id: user.id });

    return { token, userId: user.id, expiresAt: expiresAt.getTime() };
}
