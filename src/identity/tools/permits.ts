import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { PermitsInput, PermitsOutput } from '../contracts/identity.contract.js';

function matchesContract(pattern: string, contract: string): boolean {
    if (pattern === contract) return true;
    return pattern.endsWith('.*') && contract.startsWith(pattern.slice(0, -1));
}

async function expandRoles(roleKeys: readonly string[], ctx: IServiceContext): Promise<Set<string>> {
    const roles = await ctx.call('identity.role.find', { query: {} });
    const byKey = new Map(roles.map((r) => [r.key, r]));
    const result = new Set<string>();
    const stack = [...roleKeys];
    while (stack.length > 0) {
        const key = stack.pop();
        if (key === undefined || result.has(key)) continue;
        result.add(key);
        const role = byKey.get(key);
        if (role !== undefined) stack.push(...role.inherits);
    }
    return result;
}

export async function permits(
    this: IdentityService,
    input: PermitsInput,
    ctx: IServiceContext
): Promise<PermitsOutput> {
    const effectiveRoles = await expandRoles(input.roles, ctx);
    if (effectiveRoles.size === 0) return { permitted: false };
    const grants = await ctx.call('identity.grant.find', { query: {} });
    const permitted = grants.some((g) => effectiveRoles.has(g.roleKey) && matchesContract(g.contract, input.contract));

    ctx.logger.debug(`checking permits for "${input.contract}" by "${input.roles}"`, { permitted });

    return { permitted };
}
