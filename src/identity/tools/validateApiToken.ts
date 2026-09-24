import type { IServiceContext } from '@flybyme/mesh';
import type { ValidateInput, ValidateOutput } from '../contracts/apiToken.contract.js';
import { hashToken } from '../methods/hash.js';

export async function validateApiToken(
    input: ValidateInput,
    ctx: IServiceContext
): Promise<ValidateOutput> {
    const tokenHash = hashToken(input.token);
    const token = await ctx.db('identity.apiToken').findOne({ query: { tokenHash } });
    if (token === undefined || token.revokedAt !== undefined
        || (token.expiresAt !== undefined && token.expiresAt.getTime() < Date.now())) {
        return { valid: false };
    }

    // Never the token itself: anyone who can read the log could replay it.
    ctx.logger.debug(`validated api token "${token.name}" for "${token.userId}"`, { id: token.userId, name: token.name });

    return {
        valid: true,
        userId: token.userId,
        ...(token.organizationId !== undefined ? { organizationId: token.organizationId } : {}),
        roles: token.roles,
        name: token.name,
    };
}
