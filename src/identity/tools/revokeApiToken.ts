import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { RevokeInput, RevokeOutput } from '../contracts/apiToken.contract.js';
import { tokenOwner } from '../methods/tokenOwner.js';

/**
 * Revokes one of an account's api tokens, by id or name. validateApiToken already refuses a token
 * with revokedAt set, so it stops working on its very next use. Only ever within the owning
 * account: an id belonging to someone else is "not found", the same answer as an id that doesn't
 * exist.
 */
export async function revokeApiToken(
    input: RevokeInput,
    ctx: IServiceContext
): Promise<RevokeOutput> {
    if ((input.id === undefined) === (input.name === undefined)) {
        throw new MeshError({ message: 'Name the token by exactly one of id or name.', code: 'INVALID_INPUT', status: 422 });
    }
    const userId = await tokenOwner(ctx, input.userId);

    const matches = await ctx.db('identity.apiToken').find({
        query: input.id !== undefined ? { id: input.id, userId } : { name: input.name, userId },
    });
    if (matches.length === 0) {
        throw new MeshError({ message: 'No such token.', code: 'NOT_FOUND', status: 404 });
    }

    let revoked = 0;
    for (const token of matches) {
        if (token.revokedAt !== undefined) continue;
        await ctx.db('identity.apiToken').update({ id: token.id, revokedAt: new Date() });
        revoked++;
    }
    ctx.logger.debug(`revoked ${revoked} api token(s) for "${userId}"`, { id: userId, revoked });

    return { revoked };
}
