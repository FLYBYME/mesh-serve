import type { IServiceContext } from '@flybyme/mesh';

export function matchesContract(pattern: string, contract: string): boolean {
    if (pattern === contract) return true;
    return pattern.endsWith('.*') && contract.startsWith(pattern.slice(0, -1));
}

/**
 * The meta that reads one organization's memberships: a whole `user` naming it. An override of
 * `organization_id` alone kept the caller's own `user` underneath (ctx.db merges top-level keys), and
 * its organizationId won -- an operator calling from the Platform read the Platform's memberships,
 * so a Peera agent's token was refused as "not a member" (2026-10-06).
 */
export function inOrganization(ctx: IServiceContext, organizationId: string) {
    return { user: { id: ctx.meta?.user?.id ?? '', tenant_id: organizationId, organizationId } };
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
    const user = await ctx.db('identity.user').resolve({ id: userId });
    const keys = new Set<string>(user?.roles ?? []);

    if (organizationId !== undefined) {
        // Explicit meta override, not ambient ctx.meta: the organization asked about, never the caller's.
        const membership = await ctx.db('identity.membership', inOrganization(ctx, organizationId)).findOne({ query: { userId, organizationId } });
        if (membership !== undefined) {
            const role = await ctx.db('identity.role').findOne({ query: { key: membership.roleKey } });
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
    const roles = await ctx.db('identity.role').find({ query: {} });
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
