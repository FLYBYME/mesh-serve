import { MeshError } from '@flybyme/mesh';
import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { IssueInput, IssueOutput } from '../contracts/apiToken.contract.js';
import { hashToken, issuedToken } from '../methods/hash.js';

export async function issueApiToken(
    this: IdentityService,
    input: IssueInput,
    ctx: IServiceContext
): Promise<IssueOutput> {
    const user = await ctx.db('identity.user').resolve({ id: input.userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'NOT_FOUND', status: 404 });
    }

    const token = issuedToken();
    const tokenHash = hashToken(token);
    const expiresAt = input.expiresInMs === undefined ? undefined : new Date(Date.now() + input.expiresInMs);
    const roles = input.roles ?? [];

    await ctx.db('identity.apiToken').create({
        tokenHash,
        name: input.name,
        userId: input.userId,
        roles,
        ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    });

    ctx.logger.debug(`issued apiToken "${token}" to "${input.userId}"`, { id: input.userId, token });

    return {
        token,
        name: input.name,
        userId: input.userId,
        roles,
        ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.getTime() }),
    };
}
