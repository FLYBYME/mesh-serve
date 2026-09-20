import type { IServiceContext } from '@flybyme/mesh';

import type { RevokeInput, RevokeOutput } from '../contracts/ticket.contract.js';

export async function revokeTicket(
    input: RevokeInput,
    ctx: IServiceContext
): Promise<RevokeOutput> {
    const now = new Date();
    let revoked = 0;

    const tickets = input.token !== undefined
        ? [await ctx.db('identity.ticket').findOne({ query: { token: input.token } })].filter((t) => t !== undefined)
        : input.userId !== undefined
            ? await ctx.db('identity.ticket').find({ query: { userId: input.userId } })
            : [];

    for (const ticket of tickets) {
        if (ticket.revokedAt !== undefined) continue;
        await ctx.db('identity.ticket').update({
            id: ticket.id,
            revokedAt: now,
            ...(input.reason === undefined ? {} : { revokedReason: input.reason }),
        });
        ctx.emit('identity.ticket.revoked', {
            id: ticket.id,
            userId: ticket.userId,
            tokenId: ticket.token,
            revokedAt: now.getTime(),
            revokedReason: input.reason,
        });
        revoked += 1;
    }

    ctx.logger.debug(`revoked ${revoked} tickets for "${input.userId}"`, { id: input.userId, revoked });

    return { revoked, epoch: now.getTime() };
}
