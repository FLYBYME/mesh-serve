import type { IServiceContext } from '@flybyme/mesh';
import type { ValidateInput, ValidateOutput } from '../contracts/apiToken.contract.js';
import { hashToken } from '../methods/hash.js';
import { expandRoles } from '../methods/roles.js';

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

    // A token that names roles is held to them (and what they inherit): the gateway checked only
    // the account's, so a token issued "member" acted as the account's admin (review 10-26).
    const grants = token.roles.length > 0 ? [...(await expandRoles(new Set(token.roles), ctx)).keys()] : undefined;

    return {
        valid: true,
        userId: token.userId,
        ...(token.organizationId !== undefined ? { organizationId: token.organizationId } : {}),
        roles: token.roles,
        ...(grants !== undefined ? { grants } : {}),
        name: token.name,
        id: token.id,
    };
}
