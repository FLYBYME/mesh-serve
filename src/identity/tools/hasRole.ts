import type { IServiceContext } from '@flybyme/mesh';

import type { HasRoleInput, HasRoleOutput } from '../contracts/identity.contract.js';
import { resolveEffectiveRoleKeys, expandRoles } from '../methods/roles.js';

export async function hasRole(
    input: HasRoleInput,
    ctx: IServiceContext
): Promise<HasRoleOutput> {
    const roleKeys = await resolveEffectiveRoleKeys(input.userId, input.organizationId, ctx);
    const expanded = await expandRoles(roleKeys, ctx);

    ctx.logger.debug(`checking hasRole "${input.role}" for "${input.userId}"`, { organizationId: input.organizationId });

    return { granted: expanded.has(input.role) };
}
