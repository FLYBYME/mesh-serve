import type { IServiceContext } from '@flybyme/mesh';

export function matchesContract(pattern: string, contract: string): boolean {
    if (pattern === contract) return true;
    return pattern.endsWith('.*') && contract.startsWith(pattern.slice(0, -1));
}

/**
 * Global roles (identity.user.roles) always apply, everywhere. A membership's roleKey only ever
 * contributes an organization-scoped role -- account roles are king: an org cannot hand a member a
 * global role's power just by naming it in a membership row, so a membership role that turns out to
 * be scope: 'global' is ignored here rather than honored.
 */
export async function resolveEffectiveRoleKeys(
    userId: string,
    organizationId: string | undefined,
    ctx: IServiceContext,
): Promise<Set<string>> {
    const user = await ctx.call('identity.user.resolve', { id: userId });
    const keys = new Set<string>(user?.roles ?? []);

    if (organizationId !== undefined) {
        const membership = await ctx.call('identity.membership.find_one', { query: { userId, organizationId } });
        if (membership !== undefined) {
            const role = await ctx.call('identity.role.find_one', { query: { key: membership.roleKey } });
            if (role !== undefined && role.scope !== 'global') {
                keys.add(membership.roleKey);
            }
        }
    }

    return keys;
}

/**
 * Expands a role-key set through same-scope inheritance (per roleSchema's own invariant), returning
 * every reached role keyed to its own permission patterns.
 */
export async function expandRoles(
    roleKeys: ReadonlySet<string>,
    ctx: IServiceContext,
): Promise<Map<string, readonly string[]>> {
    const roles = await ctx.call('identity.role.find', { query: {} });
    const byKey = new Map(roles.map((r) => [r.key, r]));
    const seen = new Map<string, readonly string[]>();
    const stack = [...roleKeys];
    while (stack.length > 0) {
        const key = stack.pop();
        if (key === undefined || seen.has(key)) continue;
        const role = byKey.get(key);
        seen.set(key, role?.permissions ?? []);
        if (role !== undefined) stack.push(...role.inherits);
    }
    return seen;
}
