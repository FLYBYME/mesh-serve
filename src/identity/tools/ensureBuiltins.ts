import type { IServiceContext } from '@flybyme/mesh';

import { BuiltinRoles } from '../builtinRoles.js';
import type { EnsureBuiltinsOutput } from '../contracts/role.contract.js';

/**
 * Create-if-missing, not upsert: an existing row is left exactly as it is, including any
 * customization an operator already made to it (`identity.role.upsert` is the explicit, deliberate
 * way to change a builtin role's permissions after the fact). This only ever fills a genuine gap.
 */
export async function ensureBuiltins(_params: Record<string, never>, ctx: IServiceContext): Promise<EnsureBuiltinsOutput> {
    const created: string[] = [];
    const existing: string[] = [];

    for (const role of BuiltinRoles) {
        const found = await ctx.call('identity.role.find_one', { query: { key: role.key, scope: role.scope } });
        if (found) {
            existing.push(role.key);
            continue;
        }
        await ctx.call('identity.role.create', role);
        ctx.logger.info(`No "${role.key}" role found, created one.`);
        created.push(role.key);
    }

    return { created, existing };
}
