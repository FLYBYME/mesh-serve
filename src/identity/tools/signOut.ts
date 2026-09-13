import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { SignOutInput, SignOutOutput } from '../contracts/ticket.contract.js';

export async function signOut(
    this: IdentityService,
    input: SignOutInput,
    ctx: IServiceContext
): Promise<SignOutOutput> {
    const ticket = await ctx.call('identity.ticket.find_one', { query: { token: input.token } });
    if (ticket !== undefined && ticket.revokedAt === undefined) {
        await ctx.call('identity.ticket.update', { id: ticket.id, revokedAt: new Date() });

        ctx.logger.debug(`signed out ticket "${input.token}"`, { id: ticket.userId, token: input.token });
    } else {
        ctx.logger.debug(`ticket "${input.token}" not found or already revoked`, { token: input.token });
    }
    return { signedOut: true };
}
