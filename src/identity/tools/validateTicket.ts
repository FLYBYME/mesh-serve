import type { IServiceContext } from '@flybyme/mesh';

import type { ValidateInput, ValidateOutput } from '../contracts/ticket.contract.js';
import { hashToken } from '../methods/hash.js';

export async function validateTicket(
    input: ValidateInput,
    ctx: IServiceContext
): Promise<ValidateOutput> {
    // Stored hashed (schema/ticket.ts). No fallback to a raw match: a stored hash presented as a
    // token would then be accepted -- a database reader signing in as anyone.
    const ticket = await ctx.db('identity.ticket').findOne({ query: { token: hashToken(input.token) } });
    if (ticket === undefined || ticket.revokedAt !== undefined || ticket.expiresAt.getTime() < Date.now()) {
        // Never the raw token -- a bearer credential has no business sitting in a log line.
        ctx.logger.debug('ticket not found or already revoked');
        return { valid: false };
    }

    ctx.logger.debug(`validated ticket for ${ticket.userId}`);

    return { valid: true, userId: ticket.userId, roles: ticket.roles };
}
