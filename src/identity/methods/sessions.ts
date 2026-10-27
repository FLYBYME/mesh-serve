import type { IServiceContext } from '@flybyme/mesh';

/** End every session an account has (a password reset or change); answers how many ended. */
export async function endSessions(ctx: IServiceContext, userId: string, reason: string): Promise<number> {
    const tickets = await ctx.db('identity.ticket').find({ query: { userId }, limit: 1000 });
    let ended = 0;
    for (const ticket of tickets) {
        if (ticket.revokedAt !== undefined) continue;
        await ctx.db('identity.ticket').update({ id: ticket.id, revokedAt: new Date(), revokedReason: reason });
        ended++;
    }
    if (ended > 0) ctx.emit('identity.user.signed_out', { userId });

    return ended;
}

/** True when the account is gone or suspended: nothing it holds -- ticket or api token -- acts for it. */
export async function accountStopped(ctx: IServiceContext, userId: string): Promise<boolean> {
    const user = await ctx.db('identity.user').findOne({ query: { id: userId } });

    return user === undefined || user.suspendedAt !== undefined;
}
