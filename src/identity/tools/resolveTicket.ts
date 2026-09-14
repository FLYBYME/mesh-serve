import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { TicketResolveInput, TicketResolveOutput } from '../contracts/ticket.contract.js';

export async function resolveTicket(
    this: IdentityService,
    input: TicketResolveInput,
    ctx: IServiceContext
): Promise<TicketResolveOutput> {
    const ticket = await ctx.call('identity.ticket.find_one', { query: { token: input.token } });
    if (ticket === undefined) {
        ctx.logger.debug(`ticket "${input.token}" not found`, { token: input.token });
        return { ticket: undefined };
    }

    ctx.logger.debug(`resolved ticket "${input.token}"`, { id: ticket.userId, token: input.token });

    return { ticket };
}