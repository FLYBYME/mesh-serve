import type { IServiceContext } from '@flybyme/mesh';
import { IdentityService } from '../identity.service.js';
import type { ValidateInput, ValidateOutput } from '../contracts/apiToken.contract.js';
import { hashToken } from '../methods/hash.js';

export async function validateApiToken(
    this: IdentityService,
    input: ValidateInput,
    ctx: IServiceContext
): Promise<ValidateOutput> {
    const tokenHash = hashToken(input.token);
    const token = await ctx.call('identity.apiToken.find_one', { query: { tokenHash } });
    if (token === undefined || token.revokedAt !== undefined
        || (token.expiresAt !== undefined && token.expiresAt.getTime() < Date.now())) {
        return { valid: false };
    }

    ctx.logger.debug(`validated apiToken "${input.token}"`, { id: token.userId, token: input.token });

    return { valid: true, userId: token.userId, roles: token.roles, name: token.name };
}
