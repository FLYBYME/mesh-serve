import type { IServiceContext } from '@flybyme/mesh';

import type { ListInput, ListOutput } from '../contracts/apiToken.contract.js';
import { tokenOwner } from '../methods/tokenOwner.js';

/** An account's api tokens: what each is for and whether it still works -- never its hash. */
export async function listApiTokens(
    input: ListInput,
    ctx: IServiceContext
): Promise<ListOutput> {
    const userId = await tokenOwner(ctx, input.userId);
    const tokens = await ctx.db('identity.apiToken').find({ query: { userId } });

    return {
        tokens: tokens.map((t) => ({
            id: t.id,
            name: t.name,
            userId: t.userId,
            ...(t.organizationId !== undefined ? { organizationId: t.organizationId } : {}),
            roles: t.roles,
            createdAt: t.createdAt,
            ...(t.lastUsedAt !== undefined ? { lastUsedAt: t.lastUsedAt } : {}),
            ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
            ...(t.revokedAt !== undefined ? { revokedAt: t.revokedAt } : {}),
        })),
    };
}
