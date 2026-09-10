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
    /**
     * Roles this one is defined as *including*.
     *
     * **Why this is needed and holding two roles is not the answer.** `permits` takes an array, so a
     * person could hold `viewer` and `editor` — except a **membership carries one `roleKey`**. Inside
     * an organization you hold exactly one role, so without this there is no way to say *`owner` is
     * `editor` plus these two*, and every shared grant is copied into every role that wants it. The
     * copy is what drifts: adding a contract then means editing N roles and missing one.
     *
     * **Still purely additive**, so the file's own rule survives — *"a system where a role could
     * remove a permission is one where nobody can answer what can this person do without evaluating
     * order."* The union of a graph is the union whatever order it is walked in, so inheritance adds
     * a shape to traverse and no order to get wrong.
     *
     * **Two rules, both enforced when a role is written rather than when one is read** — see
     * `inheritanceProblem`:
     *
     * 1. **No cycles.** A cycle guarded at read time lives in the database for ever and every
     *    request pays to step around it. Refuse the edge that closes it, naming the path.
     * 2. **Same scope only.** If cluster-scoped `operator` could inherit organization-scoped
     *    `editor`, `permits` would find `editor`'s grants on the cluster path and honour them
     *    *everywhere* — privilege escalation performed by editing a row. This is F3's rule one level
     *    up, and surfdns issue #26 is what it looks like when the two scopes are allowed to blur.
     */
    inherits: z.array(z.string()).default([])
        .describe('Roles this one includes. Same scope only, and never cyclic.'),
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
        inherits: [],
    },
    {
        key: 'authenticated',
        name: 'Authenticated',
        scope: 'cluster',
        description: 'Held by every caller with a valid ticket. Grants nothing on its own.',
        builtin: false,
        inherits: [],
    },
    /**
     * **The role the platform itself checks for, which did not exist as a record.**
     *
     * `gate.ts` has named `operator` since gates grew the level, and every fleet handler calls
     * `requireOperator` — but nothing ever created the row, and `updateUser` refuses a role key it
     * cannot find. So the role was simultaneously load-bearing and unregistered: granting it threw
     * `Role "operator" does not exist`, which is the store correctly refusing to write a name
     * nobody had defined.
     *
     * Cluster-scoped, because it is standing across the whole deployment rather than inside one
     * organization — an organization admin is not a platform operator, and the two are deliberately
     * different questions (`gate.ts`, `ADMIN_ROLE` / `OPERATOR_ROLE`).
     *
     * `builtin: false` so a deployment can edit its description or grants; the key is what the
     * platform depends on.
     */
    {
        key: 'operator',
        name: 'Operator',
        scope: 'cluster',
        description:
            'Runs the platform: assigns services to machines, composes and deploys releases, and '
            + 'grants this role to others. Not an organization role.',
        builtin: false,
        inherits: [],
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
 * How deep an inheritance chain may go.
 *
 * A belt beside `expandInheritance`'s visited set rather than instead of it: the visited set is what
 * makes a cycle terminate, and this is what stops a *legitimate* chain from becoming something
 * nobody can reason about. Eight is far past any real hierarchy — if a deployment needs nine levels
 * of role, the answer is not a bigger number.
 */
export const MAX_INHERITANCE_DEPTH = 8;

/**
 * **The three things an authorization answer depends on, in one argument so none can be left out.**
 *
 * `permits` and `surfaceOf` took `(roles, grants, …)`. Inheritance needs a third — the deployment's
 * role table, to follow an edge by key — and adding it as an optional parameter would have made the
 * expansion **forgettable**: a caller that omitted it would get an answer that was wrong only for
 * roles that inherit, silently, and denials read as policy rather than as a bug.
 *
 * That is the exact failure this repository has now produced five times (F25, F29, F30 among them):
 * a mechanism that exists and is not reached. So the parameter is required, and it is named, because
 * three positional collections of strings is its own kind of mistake.
 */
export interface RoleWorld {
    /** What the caller holds: the principal's cluster roles, plus the membership role for the scope. */
    readonly held: readonly (Role | string)[];
    /** Every role the deployment defines. Inheritance is resolved against this. */
    readonly all: readonly Role[];
    /** Every grant. Filtered by role inside; deny by default means an empty list denies everything. */
    readonly grants: readonly Grant[];
}

/**
 * Helper to resolve Role records from Role objects or string keys.
 *
 * `all` is the deployment's role table. It used to be only `BUILTIN_ROLES`, which meant a string key
 * naming any role a deployment had defined resolved to **nothing** — silently, and a silently empty
 * role set denies rather than errors, so it reads as policy.
 */
function resolveRoles(roles: readonly (Role | string)[], all: readonly Role[]): readonly Role[] {
    const table = [...all, ...BUILTIN_ROLES.filter((b) => !all.some((r) => r.key === b.key))];
    const resolved: Role[] = [];
    for (const r of roles) {
        if (typeof r === 'string') {
            const found = table.find((b) => b.key === r);
            if (found) resolved.push(found);
        } else {
            resolved.push(r);
        }
    }
    return resolved;
}

/**
 * **Every role these roles include, transitively.**
 *
 * Pure, and it is where the same-scope rule is *honoured* — `inheritanceProblem` is where it is
 * enforced. Belt and braces on purpose: a row written before the rule existed, or by a migration, or
 * by a direct database edit, must not escalate on the read path. So a cross-scope edge is skipped
 * here rather than trusted to have been refused earlier.
 *
 * The visited set makes a cycle terminate rather than recurse. It is deliberately keyed on the role
 * key, not on the object, because two reads of the same role are two objects.
 */
export function expandInheritance(
    held: readonly (Role | string)[],
    all: readonly Role[],
): readonly Role[] {
    const start = resolveRoles(held, all);
    const byKey = new Map(all.map((r) => [r.key, r]));
    for (const builtin of BUILTIN_ROLES) if (!byKey.has(builtin.key)) byKey.set(builtin.key, builtin);

    const seen = new Set<string>();
    const out: Role[] = [];

    const walk = (role: Role, depth: number): void => {
        if (seen.has(role.key) || depth > MAX_INHERITANCE_DEPTH) return;
        seen.add(role.key);
        out.push(role);

        for (const key of role.inherits) {
            const next = byKey.get(key);
            // An edge naming a role that does not exist is skipped, not thrown: a deleted role must
            // not take every role that mentioned it out of service.
            if (next === undefined) continue;
            // The read-path half of the same-scope rule. See the doc on `inherits`.
            if (next.scope !== role.scope) continue;
            walk(next, depth + 1);
        }
    };

    for (const role of start) walk(role, 0);
    return out;
}

/**
 * **May this role be written?** Returns the reason it may not, or `undefined`.
 *
 * Called before a role is stored, so the two rules on `inherits` are refused at the point somebody
 * can still fix them — with the offending path in the message, because *"role graph is invalid"*
 * sends a person reading rows one at a time.
 *
 * `all` is the role table **as it will be after this write**, minus this role; the caller supplies
 * it that way so a role being renamed or re-parented is judged on the world it is creating.
 */
export function inheritanceProblem(role: Role, all: readonly Role[]): string | undefined {
    const byKey = new Map(all.filter((r) => r.key !== role.key).map((r) => [r.key, r]));
    byKey.set(role.key, role);

    for (const key of role.inherits) {
        const parent = byKey.get(key);
        if (parent === undefined) {
            return `Role "${role.key}" inherits "${key}", which does not exist.`;
        }
        if (parent.scope !== role.scope) {
            return `Role "${role.key}" is ${role.scope}-scoped and cannot inherit "${key}", which is `
                + `${parent.scope}-scoped. A ${parent.scope} role inherited by a ${role.scope} one would `
                + `grant everywhere it does, which is an escalation performed by editing a row.`;
        }
    }

    // Depth-first from this role, carrying the path, so the cycle can be printed rather than named.
    const path: string[] = [];
    const onPath = new Set<string>();

    const visit = (current: Role): string | undefined => {
        if (onPath.has(current.key)) {
            return `Role "${role.key}" cannot inherit "${path[path.length - 1] ?? ''}": it would close `
                + `the cycle ${[...path, current.key].join(' -> ')}.`;
        }
        if (path.length > MAX_INHERITANCE_DEPTH) {
            return `Role "${role.key}" inherits more than ${String(MAX_INHERITANCE_DEPTH)} levels `
                + `deep (${[...path, current.key].join(' -> ')}).`;
        }

        onPath.add(current.key);
        path.push(current.key);
        for (const key of current.inherits) {
            const next = byKey.get(key);
            if (next === undefined) continue;
            const problem = visit(next);
            if (problem !== undefined) return problem;
        }
        path.pop();
        onPath.delete(current.key);
        return undefined;
    };

    return visit(role);
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
    world: RoleWorld,
    organizationId?: string,
): ReadonlySet<string> {
    const { grants } = world;
    const resolved = expandInheritance(world.held, world.all);
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
    world: RoleWorld,
    contract: string,
    organizationId?: string,
): boolean {
    const { grants } = world;
    const resolved = expandInheritance(world.held, world.all);
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
