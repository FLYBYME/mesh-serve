import { MeshError } from '@flybyme/mesh';
import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { UpsertInput, UpsertOutput } from '../contracts/role.contract.js';

export async function upsertRole(
    this: IdentityService,
    input: UpsertInput,
    ctx: IServiceContext
): Promise<UpsertOutput> {
    const roles = await ctx.call('identity.role.find', { query: {} });
    const byKey = new Map(roles.map((r) => [r.key, r]));
    const existing = byKey.get(input.key);

    for (const parentKey of input.inherits) {
        const parent = byKey.get(parentKey);
        if (parent === undefined) {
            throw new MeshError({
                message: `Role "${input.key}" inherits unknown role "${parentKey}".`,
                code: 'INVALID_INPUT',
                status: 422,
            });
        }
        if (parent.scope !== input.scope) {
            throw new MeshError({
                message: `Role "${input.key}" cannot inherit "${parentKey}": different scope.`,
                code: 'INVALID_INPUT',
                status: 422,
            });
        }
    }

    const visited = new Set<string>();
    const stack = [...input.inherits];
    while (stack.length > 0) {
        const key = stack.pop();
        if (key === undefined || visited.has(key)) continue;
        if (key === input.key) {
            throw new MeshError({
                message: `Role "${input.key}" inherits itself, directly or indirectly.`,
                code: 'INVALID_INPUT',
                status: 422,
            });
        }
        visited.add(key);
        const parent = byKey.get(key);
        if (parent !== undefined) stack.push(...parent.inherits);
    }

    if (existing === undefined) {
        await ctx.call('identity.role.create', { ...input });

        ctx.logger.debug(`created role "${input.key}"`, { key: input.key });

        return { key: input.key, created: true };
    }
    await ctx.call('identity.role.update', { id: existing.id, ...input });

    ctx.logger.debug(`updated role "${input.key}"`, { key: input.key });

    return { key: input.key, created: false };
}
