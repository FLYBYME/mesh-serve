import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { ValidateInput, ValidateOutput } from '../contracts/ticket.contract.js';

export async function validateTicket(
    this: IdentityService,
    input: ValidateInput,
    ctx: IServiceContext
): Promise<ValidateOutput> {
    const ticket = await ctx.call('identity.ticket.find_one', { query: { token: input.token } });
    if (ticket === undefined || ticket.revokedAt !== undefined || ticket.expiresAt.getTime() < Date.now()) {
        ctx.logger.debug(`ticket "${input.token}" not found or already revoked`, { token: input.token });
        return { valid: false };
    }

    ctx.logger.debug(`validated ticket "${input.token}"`, { id: ticket.userId, token: input.token });

    return { valid: true, userId: ticket.userId, roles: ticket.roles };
}
