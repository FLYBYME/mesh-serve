import type { IServiceContext } from '@flybyme/mesh';

import type { TicketResolveInput, TicketResolveOutput } from '../contracts/ticket.contract.js';

export async function resolveTicket(
    input: TicketResolveInput,
    ctx: IServiceContext
): Promise<TicketResolveOutput> {
    const ticket = await ctx.db('identity.ticket').findOne({ query: { token: input.token } });
    if (ticket === undefined) {
        ctx.logger.debug(`ticket "${input.token}" not found`, { token: input.token });
        return { ticket: undefined };
    }

    ctx.logger.debug(`resolved ticket "${input.token}"`, { id: ticket.userId, token: input.token });

    return { ticket };
}