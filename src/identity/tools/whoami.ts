import { MeshError } from '@flybyme/mesh';
import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { WhoamiInput, WhoamiOutput } from '../contracts/identity.contract.js';

export async function whoami(
    this: IdentityService,
    _input: WhoamiInput,
    ctx: IServiceContext
): Promise<WhoamiOutput> {
    const userId = ctx.meta?.user?.id;
    if (userId === undefined) {
        throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const user = await ctx.call('identity.user.resolve', { id: userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'UNAUTHENTICATED', status: 401 });
    }

    const memberships = await ctx.call('identity.membership.find', { query: {} });
    const organizations = await Promise.all(memberships.map(async (m) => {
        const org = await ctx.call('identity.organization.resolve', { id: m.organizationId });
        return {
            organizationId: m.organizationId,
            name: org?.name ?? 'unknown',
            roleKey: m.roleKey,
        };
    }));

    ctx.logger.debug(`whoami for user "${userId}"`, {
        id: userId,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
        organizations,
    });

    return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
        organizations,
    };
}
