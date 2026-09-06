/**
 * Roles are records, not an enum — mesh-web spec/auth.md §5, decided.
 *
 * surfdns compiled `public | user | admin` into its source. That cannot survive identity being a
 * base for other projects, because every project's roles are different: a blog has `reader`,
 * `author` and `editor`; a trading platform has `trader`, `risk` and `compliance`. An enum in the
 * framework means each of them either contorts into three levels or forks it.
 *
 * So a role is a row. Which makes three things fall out that were previously special cases:
 *
 * - **`public` is a role like any other** — the role of a caller with no ticket. One resolution
 *   path, rather than "check if public, else resolve the principal, else check the level".
 * - **Grants are additive and deny by default.** The union of your roles' grants is your surface.
 *   A system where a role could *remove* a permission is one where nobody can answer "what can this
 *   person do" without evaluating order.
 * - **Scope is a field, and required.** See below; this is the one that fixes a live bug.
 */

import { z } from 'zod';

/**
 * Where a role holds.
 *
 * **Required, and enforced in code (F3).** surfdns issue #26 exists because `admin` means two
 * different things there — `roleSatisfies('admin')` is organization-scoped while `auth: 'admin'` is
 * cluster-scoped, and nothing connects them, so *nobody can actually be a platform operator*.
 *
 * Enforcement:
 * - A cluster-scoped role grants everywhere; an organization-scoped role grants only when acting
 *   in an organization (`permits`).
 * - An organization-scoped key may not enter `user.roles` (`createUser`, `updateUser`).
 * - A cluster-scoped key may not become a `membership.roleKey` (`createMembership`).
 */
export const RoleScopeSchema = z.enum(['cluster', 'organization']);
export type RoleScope = z.infer<typeof RoleScopeSchema>;

export const RoleSchema = z.object({
    /** Stable and referenced by grants and memberships, so it is chosen rather than generated. */
    key: z.string().min(1).describe('Stable identifier, e.g. `author` or `operator`'),
    name: z.string().min(1).describe('What a person is shown'),
    scope: RoleScopeSchema.describe('Where this role holds: the whole deployment, or one organization'),
    description: z.string().optional(),
    /**
     * Shipped with identity and not deletable (F8a).
     *
     * Only `public` is, because a deployment with no `public` role has no way to answer an
     * anonymous request at all — and that is a state it should not be possible to configure into.
     * Deletion of a builtin role is refused with a ClientError.
     */
    builtin: z.boolean().default(false),
});

export type Role = z.infer<typeof RoleSchema>;

/**
 * One contract a role may call.
 *
 * A row per (role, contract) rather than an array on the role, because the interesting queries run
 * the other way — *who can call this* — and because two administrators editing different roles must
 * not write the same document.
 */
export const GrantSchema = z.object({
    roleKey: z.string().min(1),
    /**
     * A contract key, or a pattern.
     *
     * `identity.whoami` grants one. `post.*` grants a domain. There is deliberately no `*`: a role
     * that can call everything is one nobody has to think about, and thinking about it is the point.
     */
    contract: z.string().min(1),
    description: z.string().optional(),
});

export type Grant = z.infer<typeof GrantSchema>;

/** The role every caller has, including one with no ticket. */
export const PUBLIC_ROLE = 'public';

/**
 * The roles identity ships with.
 *
 * Two, and only two. Every other role is the deployment's to define — a framework that shipped
 * `editor` would be guessing at a blog, and a framework that shipped `admin` would be repeating the
 * mistake in #26.
 */
export const BUILTIN_ROLES: readonly Role[] = [
    {
        key: PUBLIC_ROLE,
        name: 'Public',
        scope: 'cluster',
        description: 'Held by every caller, including one with no ticket.',
        builtin: true,
    },
    {
        key: 'authenticated',
        name: 'Authenticated',
        scope: 'cluster',
        description: 'Held by every caller with a valid ticket. Grants nothing on its own.',
        builtin: false,
    },
];

/**
 * Does a grant cover this contract?
 *
 * `post.*` matches `post.list`; `post.list` matches only itself. Written once here because a second
 * implementation of pattern matching is a second set of rules about what `*` means, and the two
 * would disagree on the day it mattered.
 */
export function grantCovers(pattern: string, contract: string): boolean {
    if (pattern === contract) return true;
    if (!pattern.endsWith('.*')) return false;

    const domain = pattern.slice(0, -2);
    // `post.*` covers `post.list` but not `postal.list`: the dot has to be there.
    return contract.startsWith(`${domain}.`);
}

/**
 * Helper to resolve Role records from Role objects or builtin string keys.
 */
function resolveRoles(roles: readonly (Role | string)[]): readonly Role[] {
    const resolved: Role[] = [];
    for (const r of roles) {
        if (typeof r === 'string') {
            const builtin = BUILTIN_ROLES.find((b) => b.key === r);
            if (builtin) resolved.push(builtin);
        } else {
            resolved.push(r);
        }
    }
    return resolved;
}

/**
 * The contracts these roles may call.
 *
 * Deny by default: a contract not granted to any role you hold is refused, and there is no path
 * here that widens a surface — grants only ever add.
 *
 * Cluster roles grant everywhere; organization roles grant only when acting in an organization.
 */
export function surfaceOf(
    roles: readonly (Role | string)[],
    grants: readonly Grant[],
    organizationId?: string,
): ReadonlySet<string> {
    const resolved = resolveRoles(roles);
    const out = new Set<string>();
    for (const grant of grants) {
        const matchingRole = resolved.find((r) => r.key === grant.roleKey);
        if (!matchingRole) continue;
        if (matchingRole.scope === 'cluster') {
            out.add(grant.contract);
        } else if (matchingRole.scope === 'organization' && organizationId !== undefined && organizationId.length > 0) {
            out.add(grant.contract);
        }
    }
    return out;
}

/**
 * May a caller holding these roles call this contract?
 *
 * Resolving rows means passing the `Role` rows in rather than bare strings:
 * keeping `permits` pure and moving the asynchronous store lookup to the caller.
 * A pure signature is predictable, easily testable, and separates policy evaluation
 * from storage I/O.
 *
 * Scope enforcement (F3):
 * - A cluster-scoped role grants everywhere (the operator concept).
 * - An organization-scoped role grants only within the organization the caller is acting in.
 *   If no organization is provided (e.g. an unscoped caller), organization grants are refused.
 */
export function permits(
    roles: readonly (Role | string)[],
    grants: readonly Grant[],
    contract: string,
    organizationId?: string,
): boolean {
    const resolved = resolveRoles(roles);
    return grants.some((grant) => {
        if (!grantCovers(grant.contract, contract)) return false;
        const matchingRole = resolved.find((r) => r.key === grant.roleKey);
        if (!matchingRole) return false;
        if (matchingRole.scope === 'cluster') return true;
        if (matchingRole.scope === 'organization' && organizationId !== undefined && organizationId.length > 0) {
            return true;
        }
        return false;
    });
}
