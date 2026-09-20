import type { IServiceContext } from '@flybyme/mesh';

import type { PermitsInput, PermitsOutput } from '../contracts/identity.contract.js';
import { matchesContract, resolveEffectiveRoleKeys, expandRoles } from '../methods/roles.js';

export async function permits(
    input: PermitsInput,
    ctx: IServiceContext
): Promise<PermitsOutput> {
    const roleKeys = await resolveEffectiveRoleKeys(input.userId, input.organizationId, ctx);
    if (roleKeys.size === 0) return { permitted: false };

    const expanded = await expandRoles(roleKeys, ctx);
    const permitted = [...expanded.values()].some((permissions) => permissions.some((pattern) => matchesContract(pattern, input.contract)));

    ctx.logger.debug(`checking permits for "${input.contract}" by "${input.userId}"`, { permitted, organizationId: input.organizationId });

    return { permitted };
}
