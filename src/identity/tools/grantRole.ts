import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { GrantRoleInput, GrantRoleOutput } from '../contracts/user.contract.js';

export async function grantRole(
    input: GrantRoleInput,
    ctx: IServiceContext
): Promise<GrantRoleOutput> {
    const role = await ctx.db('identity.role').findOne({ query: { key: input.role } });
    if (role === undefined) {
        throw new MeshError({ message: `No role "${input.role}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (input.userId === undefined && input.email === undefined) {
        throw new MeshError({ message: 'Name the account by userId or email.', code: 'INVALID_INPUT', status: 422 });
    }

    const user = input.userId !== undefined
        ? await ctx.db('identity.user').resolve({ id: input.userId })
        : await ctx.db('identity.user').findOne({ query: { email: input.email } });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'NOT_FOUND', status: 404 });
    }

    const has = user.roles.includes(input.role);
    const changed = input.granted ? !has : has;
    const roles = input.granted
        ? (has ? user.roles : [...user.roles, input.role])
        : user.roles.filter((r) => r !== input.role);

    if (changed) {
        ctx.logger.debug(`granting role "${input.role}" to "${user.id}"`, { id: user.id, roles });
        await ctx.db('identity.user').update({ id: user.id, roles });
    } else {
        ctx.logger.debug(`role "${input.role}" already granted to "${user.id}"`, { id: user.id, roles });
    }
    return { userId: user.id, roles, changed };
}
