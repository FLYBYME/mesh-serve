import type { IServiceContext } from '@flybyme/mesh';

import type { SignOutInput, SignOutOutput } from '../contracts/ticket.contract.js';

export async function signOut(
    input: SignOutInput,
    ctx: IServiceContext
): Promise<SignOutOutput> {
    const ticket = await ctx.db('identity.ticket').findOne({ query: { token: input.token } });
    if (ticket !== undefined && ticket.revokedAt === undefined) {
        await ctx.db('identity.ticket').update({ id: ticket.id, revokedAt: new Date() });

        ctx.emit('identity.user.signed_out', { userId: ticket.userId });

        // Never the ticket itself -- it is a bearer credential.
        ctx.logger.debug(`signed out a ticket for "${ticket.userId}"`, { id: ticket.userId });
    } else {
        ctx.logger.debug('ticket not found or already revoked');
    }
    return { signedOut: true };
}
