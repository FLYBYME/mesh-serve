import type { IServiceContext } from '@flybyme/mesh';

import type { TicketResolveInput, TicketResolveOutput } from '../contracts/ticket.contract.js';

export async function resolveTicket(
    input: TicketResolveInput,
    ctx: IServiceContext
): Promise<TicketResolveOutput> {
    const ticket = await ctx.db('identity.ticket').findOne({ query: { token: input.token } });
    if (ticket === undefined) {
        // Never the ticket itself -- it is a bearer credential.
        ctx.logger.debug('ticket not found');
        return { ticket: undefined };
    }

    ctx.logger.debug(`resolved ticket for "${ticket.userId}"`, { id: ticket.userId });

    return { ticket };
}