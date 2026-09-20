import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { WhoamiInput, WhoamiOutput } from '../contracts/identity.contract.js';
import { membershipCrud } from '../contracts/membership.contract.js';

export async function whoami(
    _input: WhoamiInput,
    ctx: IServiceContext
): Promise<WhoamiOutput> {
    const userId = ctx.meta?.user?.id;
    // '' is api.service.ts's own stand-in for "no caller" (ApiService.handleRequest always
    // resolves a tenant scope now, even anonymously, so it can no longer signal "no caller" by
    // leaving meta.user absent entirely) -- treated the same as an absent id.
    if (userId === undefined || userId === '') {
        throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const user = await ctx.db('identity.user').resolve({ id: userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'UNAUTHENTICATED', status: 401 });
    }

    // Raw lookup, not the scoped identity.membership.find -- that collection is scoped by
    // organizationId now (see membership.contract.ts), so a plain find here would need an org id
    // this caller doesn't have yet; finding every org a user belongs to is exactly the one place
    // that still needs a query by userId across all orgs.
    const db = ctx.broker.getProvider<Database>('database');
    const memberships = await db.repo(membershipCrud.outputSchema, 'identity.membership').find({ query: { userId } });
    const organizations = await Promise.all(memberships.map(async (m) => {
        const org = await ctx.db('identity.organization').resolve({ id: m.organizationId });
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
