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

        ctx.logger.debug(`signed out ticket "${input.token}"`, { id: ticket.userId, token: input.token });
    } else {
        ctx.logger.debug(`ticket "${input.token}" not found or already revoked`, { token: input.token });
    }
    return { signedOut: true };
}
