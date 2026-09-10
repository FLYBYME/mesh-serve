/**
 * Roles as records — mesh-web spec/auth.md §5, roadmap C1.5 and C1.6.
 *
 * The point of these is not that a Set works. It is that the three properties the design claims are
 * actually properties: `public` is an ordinary role, grants only ever add, and a role's scope is
 * part of its identity so `admin` cannot mean two things.
 */

import { describe, expect, it } from 'vitest';

import {
    BUILTIN_ROLES, MAX_INHERITANCE_DEPTH, PUBLIC_ROLE, RoleSchema,
    grantCovers, inheritanceProblem, permits, surfaceOf,
    type Grant, type Role,
} from '../../src/identity/index.js';

const publicRole = BUILTIN_ROLES.find((r) => r.key === PUBLIC_ROLE)!;
const authRole = BUILTIN_ROLES.find((r) => r.key === 'authenticated')!;
const authorRole: Role = { key: 'author', name: 'Author', scope: 'cluster', builtin: false, inherits: [] };
const operatorRole: Role = { key: 'operator', name: 'Operator', scope: 'cluster', builtin: false, inherits: [] };

const grants: readonly Grant[] = [
    { roleKey: PUBLIC_ROLE, contract: 'identity.register' },
    { roleKey: 'authenticated', contract: 'identity.whoami' },
    { roleKey: 'author', contract: 'post.*' },
    { roleKey: 'operator', contract: 'node.status' },
];

/**
 * The deployment's role table, which `permits` needs in order to follow an `inherits` edge by key.
 *
 * It is a required field rather than an optional one, so these calls read a little longer than they
 * did. That is deliberate: an optional role table would make inheritance forgettable, and a caller
 * that forgot would get an answer wrong only for roles that inherit — silently, and a wrong denial
 * reads as policy rather than as a bug.
 */
const ALL: readonly Role[] = [...BUILTIN_ROLES, authorRole];

const world = (
    held: readonly (Role | string)[],
    withGrants: readonly Grant[] = grants,
    all: readonly Role[] = ALL,
): { held: readonly (Role | string)[]; all: readonly Role[]; grants: readonly Grant[] } =>
    ({ held, all, grants: withGrants });

describe('public is a role like any other', () => {
    it('is what a caller with no ticket holds', () => {
        // Not a special case in the resolver: one path, and an anonymous caller simply holds the
        // role everyone holds.
        expect(permits(world([publicRole]), 'identity.register')).toBe(true);
        expect(permits(world([publicRole]), 'identity.whoami')).toBe(false);
    });

    it('ships with identity, and so do exactly three other roles', () => {
        /**
         * A framework that shipped `editor` would be guessing at a blog, and one that shipped
         * `admin` would repeat the ambiguity in surfdns #26. That rule holds, and `operator` is
         * not an exception to it — it is the case the rule was never about.
         *
         * The difference is who depends on the string. `editor` would be a guess about somebody's
         * product; `operator` is checked by *this* code — `gate.ts` resolves `auth: 'operator'`
         * against exactly that key, and every fleet handler calls `requireOperator`. Leaving it out
         * did not keep the platform unopinionated, it left a role the platform requires and cannot
         * create: granting it threw `Role "operator" does not exist` from inside `onStart`, which
         * killed the node and had systemd restart it into the same crash.
         *
         * So the test is not relaxed. The list is still exactly the roles the platform itself
         * needs, and anything a deployment means by `author` or `compliance` is still its own.
         *
         * **`owner` joined on the same test, for the same reason, on 2026-09-10 (F32).** It is
         * written as a `roleKey` by `transferOwnership` and `reownOrganization` in both stores —
         * seven places — and was never a record, so every organization owner on the platform held a
         * role that did not exist. It is this repository's own string, not a guess about somebody's
         * product, which is exactly the line this test draws.
         */
        expect(BUILTIN_ROLES.map((r) => r.key)).toEqual([PUBLIC_ROLE, 'authenticated', 'operator', 'owner']);

        // Cluster-scoped: standing across the deployment, not inside one organization. An
        // organization admin is not a platform operator (`gate.ts`, ADMIN_ROLE / OPERATOR_ROLE).
        expect(BUILTIN_ROLES.find((r) => r.key === 'operator')?.scope).toBe('cluster');
        // And `owner` is the other half of that sentence: a fact about one organization, never
        // standing across the deployment. Getting this backwards is surfdns #26.
        expect(BUILTIN_ROLES.find((r) => r.key === 'owner')?.scope).toBe('organization');
        // Only public is builtin (not deletable) — see roles.builtin comment and F8a
        expect(BUILTIN_ROLES.find((r) => r.key === PUBLIC_ROLE)?.builtin).toBe(true);
        expect(BUILTIN_ROLES.find((r) => r.key === 'authenticated')?.builtin).toBe(false);
    });

    it('grants nothing on its own by being authenticated', () => {
        // `authenticated` is a fact, not a permission. Holding it gets you whatever the deployment
        // granted it and no more.
        expect(permits(world([authRole]), 'post.list')).toBe(false);
    });
});

describe('grants add, and only add', () => {
    it('is the union of every role held', () => {
        expect(permits(world([publicRole, authorRole]), 'post.list')).toBe(true);
        expect(permits(world([publicRole, authorRole]), 'identity.register')).toBe(true);
    });

    it('denies anything nothing granted', () => {
        // Deny by default: there is no rule that says yes unless something says no.
        expect(permits(world([authorRole]), 'node.status')).toBe(false);
        expect(permits(world([]), 'identity.register')).toBe(false);
    });

    it('has no way for a role to take a permission away', () => {
        // A system where a role could *remove* one is a system where nobody can answer "what can
        // this person do" without evaluating order. Adding a role never shrinks the surface.
        const alone = surfaceOf(world([authorRole]));
        const withMore = surfaceOf(world([authorRole, publicRole, operatorRole]));

        for (const contract of alone) expect(withMore.has(contract)).toBe(true);
        expect(withMore.size).toBeGreaterThan(alone.size);
    });
});

describe('a grant pattern', () => {
    it('matches a domain with `.*`, and only on a dot boundary', () => {
        expect(grantCovers('post.*', 'post.list')).toBe(true);
        expect(grantCovers('post.*', 'post.create')).toBe(true);

        // The trap: `postal.list` is not `post.*`. Without the dot this would grant a domain
        // nobody named.
        expect(grantCovers('post.*', 'postal.list')).toBe(false);
        expect(grantCovers('post.*', 'post')).toBe(false);
    });

    it('matches one contract exactly otherwise', () => {
        expect(grantCovers('identity.whoami', 'identity.whoami')).toBe(true);
        expect(grantCovers('identity.whoami', 'identity.whoami_extra')).toBe(false);
    });

    it('has no way to grant everything', () => {
        // Deliberate: a role that can call anything is one nobody has to think about, and thinking
        // about it is the point. `*` is not a pattern, so it matches only a contract named `*`.
        expect(grantCovers('*', 'post.list')).toBe(false);
        expect(permits(world([authorRole], [{ roleKey: 'author', contract: '*' }]), 'post.list')).toBe(false);
    });
});

describe('scope is part of a role, which is what fixes #26', () => {
    it('is required', () => {
        // surfdns #26 is possible because roles are strings: `roleSatisfies('admin')` is
        // organization-scoped and `auth: 'admin'` is cluster-scoped, and nothing connects them. A
        // record without a scope will not parse.
        expect(RoleSchema.safeParse({ key: 'admin', name: 'Admin' }).success).toBe(false);
        expect(RoleSchema.safeParse({ key: 'admin', name: 'Admin', scope: 'cluster' }).success).toBe(true);
    });

    it('lets the two meanings of "admin" be two different records', () => {
        const clusterAdmin = RoleSchema.parse({ key: 'operator', name: 'Operator', scope: 'cluster' });
        const orgAdmin = RoleSchema.parse({ key: 'admin', name: 'Org admin', scope: 'organization' });

        // They can coexist, they cannot be confused, and a grant naming one does not reach the
        // other — which is the whole of the structural fix.
        expect(clusterAdmin.scope).not.toBe(orgAdmin.scope);
        expect(clusterAdmin.key).not.toBe(orgAdmin.key);
    });

    it('rejects a scope that is neither', () => {
        expect(RoleSchema.safeParse({ key: 'x', name: 'X', scope: 'team' }).success).toBe(false);
    });

    it('enforces scope in permits: cluster grants everywhere, organization grants only within scope', () => {
        const clusterAdmin = RoleSchema.parse({ key: 'operator', name: 'Operator', scope: 'cluster' });
        const orgAdmin = RoleSchema.parse({ key: 'admin', name: 'Org admin', scope: 'organization' });
        const testGrants = [
            { roleKey: 'operator', contract: 'system.reboot' },
            { roleKey: 'admin', contract: 'org.settings' },
        ];

        // Cluster role grants everywhere
        expect(permits(world([clusterAdmin], testGrants, [clusterAdmin, orgAdmin]), 'system.reboot')).toBe(true);
        expect(permits(world([clusterAdmin], testGrants, [clusterAdmin, orgAdmin]), 'system.reboot', 'org-1')).toBe(true);

        // Org role grants only when acting in an organization
        expect(permits(world([orgAdmin], testGrants, [clusterAdmin, orgAdmin]), 'org.settings')).toBe(false);
        expect(permits(world([orgAdmin], testGrants, [clusterAdmin, orgAdmin]), 'org.settings', 'org-1')).toBe(true);
    });
});

/**
 * **Inheritance: `owner` is `editor` plus these, said once instead of copied.**
 *
 * The alternative is holding several roles, and it does not reach: `permits` takes an array, but a
 * **membership carries one `roleKey`**. Inside an organization you hold exactly one role, so without
 * inheritance every shared grant is copied into every role that wants it — and the copy is what
 * drifts, because adding a contract then means editing N roles and missing one.
 *
 * Two rules, and the second is the one that matters. See `inheritanceProblem`.
 */
describe('a role may include another role', () => {
    const viewer: Role = { key: 'viewer', name: 'Viewer', scope: 'organization', builtin: false, inherits: [] };
    const editor: Role = { key: 'editor', name: 'Editor', scope: 'organization', builtin: false, inherits: ['viewer'] };
    const owner: Role = { key: 'owner', name: 'Owner', scope: 'organization', builtin: false, inherits: ['editor'] };
    const orgRoles = [viewer, editor, owner];
    const orgGrants: readonly Grant[] = [
        { roleKey: 'viewer', contract: 'card.find' },
        { roleKey: 'editor', contract: 'card.update' },
        { roleKey: 'owner', contract: 'project.delete' },
    ];

    it('carries the grants of everything it includes, transitively', () => {
        // owner -> editor -> viewer, two hops, and the whole point is that `project.delete` did not
        // have to be written three times.
        const held = world([owner], orgGrants, orgRoles);

        expect(permits(held, 'project.delete', 'org-1')).toBe(true);
        expect(permits(held, 'card.update', 'org-1')).toBe(true);
        expect(permits(held, 'card.find', 'org-1')).toBe(true);
    });

    it('does not run backwards', () => {
        // A viewer is not an owner. Inheritance is a direction, and getting it wrong here would be
        // the least noticeable possible bug: everybody would simply be able to do everything.
        const held = world([viewer], orgGrants, orgRoles);

        expect(permits(held, 'card.find', 'org-1')).toBe(true);
        expect(permits(held, 'card.update', 'org-1')).toBe(false);
        expect(permits(held, 'project.delete', 'org-1')).toBe(false);
    });

    it('terminates on a cycle instead of recursing', () => {
        // Belt to `inheritanceProblem`'s braces: a row written before the rule existed, or by a
        // direct database edit, must not take the process down on the read path.
        const a: Role = { key: 'a', name: 'A', scope: 'cluster', builtin: false, inherits: ['b'] };
        const b: Role = { key: 'b', name: 'B', scope: 'cluster', builtin: false, inherits: ['a'] };

        const held = world([a], [{ roleKey: 'b', contract: 'x.y' }], [a, b]);
        expect(permits(held, 'x.y')).toBe(true);
    });

    it('ignores an edge naming a role that no longer exists', () => {
        // A deleted role must not take every role that mentioned it out of service.
        const orphan: Role = { key: 'orphan', name: 'Orphan', scope: 'cluster', builtin: false, inherits: ['gone'] };
        const held = world([orphan], [{ roleKey: 'orphan', contract: 'x.y' }], [orphan]);

        expect(permits(held, 'x.y')).toBe(true);
    });

    /**
     * **The escalation the same-scope rule exists to prevent.**
     *
     * A cluster role inheriting an organization role would find that role's grants on the *cluster*
     * path, where `permits` honours them everywhere — so somebody able to edit one row could turn a
     * grant scoped to one organization into a grant that holds across the deployment, with no
     * organization in the request at all. F3's rule, one level up.
     */
    it('refuses to follow an edge across scopes, at read time', () => {
        const orgEditor: Role = {
            key: 'org-editor', name: 'Org editor', scope: 'organization', builtin: false, inherits: [],
        };
        const clusterRole: Role = {
            key: 'sneaky', name: 'Sneaky', scope: 'cluster', builtin: false, inherits: ['org-editor'],
        };
        const held = world(
            [clusterRole],
            [{ roleKey: 'org-editor', contract: 'card.update' }],
            [clusterRole, orgEditor],
        );

        // Not granted anywhere: not with no organization, and not inside one either.
        expect(permits(held, 'card.update')).toBe(false);
        expect(permits(held, 'card.update', 'org-1')).toBe(false);
    });

    it('stops at the depth cap', () => {
        // A legitimate chain nobody can reason about is its own problem, separate from a cycle.
        const chain: Role[] = [];
        for (let i = 0; i <= MAX_INHERITANCE_DEPTH + 2; i += 1) {
            chain.push({
                key: `r${String(i)}`,
                name: `R${String(i)}`,
                scope: 'cluster',
                builtin: false,
                inherits: i === MAX_INHERITANCE_DEPTH + 2 ? [] : [`r${String(i + 1)}`],
            });
        }
        const deepest = chain[chain.length - 1]!;
        const held = world([chain[0]!], [{ roleKey: deepest.key, contract: 'far.away' }], chain);

        expect(permits(held, 'far.away')).toBe(false);
    });
});

/**
 * **Both rules are refused when a role is written, not guarded when one is read.**
 *
 * A cycle guarded only at read time lives in the database for ever and every request pays to step
 * around it. `expandInheritance` still steps around one — a row can predate the rule — but the place
 * a person can *fix* it is the write, and that is where the message belongs.
 */
describe('a role that would break the graph is refused', () => {
    const viewer: Role = { key: 'viewer', name: 'Viewer', scope: 'organization', builtin: false, inherits: [] };

    it('allows an ordinary edge', () => {
        const editor: Role = { key: 'editor', name: 'Editor', scope: 'organization', builtin: false, inherits: ['viewer'] };
        expect(inheritanceProblem(editor, [viewer])).toBeUndefined();
    });

    it('names the cycle it would close', () => {
        const a: Role = { key: 'a', name: 'A', scope: 'cluster', builtin: false, inherits: ['b'] };
        const b: Role = { key: 'b', name: 'B', scope: 'cluster', builtin: false, inherits: ['a'] };

        const problem = inheritanceProblem(a, [b]);
        expect(problem).toBeDefined();
        // The path, not just the fact: "role graph is invalid" sends a person reading rows one at a
        // time, which is how a graph problem becomes an afternoon.
        expect(problem).toContain('a -> b -> a');
    });

    it('refuses a role inheriting itself', () => {
        const self: Role = { key: 'self', name: 'Self', scope: 'cluster', builtin: false, inherits: ['self'] };
        expect(inheritanceProblem(self, [])).toContain('self -> self');
    });

    it('refuses an edge across scopes, and says which way round', () => {
        const clusterRole: Role = {
            key: 'sneaky', name: 'Sneaky', scope: 'cluster', builtin: false, inherits: ['viewer'],
        };
        const problem = inheritanceProblem(clusterRole, [viewer]);

        expect(problem).toContain('cluster');
        expect(problem).toContain('organization');
        expect(problem).toContain('escalation');
    });

    it('refuses an edge to a role that does not exist', () => {
        // At write time this is a typo, and a typo that silently grants nothing is worse than one
        // that is refused — the role would appear to work and quietly carry less than intended.
        const typo: Role = { key: 'editor', name: 'Editor', scope: 'organization', builtin: false, inherits: ['veiwer'] };
        expect(inheritanceProblem(typo, [viewer])).toContain('does not exist');
    });
});

/**
 * **F32: the role every organization owner holds, which was not a record.**
 *
 * `roleKey: 'owner'` is written by `transferOwnership` and `reownOrganization` in both stores, and
 * nothing created the role. It hid twice over: those two write the membership document directly, so
 * `createMembership`'s validation — which refuses a roleKey that does not exist — never ran on the
 * path that mattered; and the read side is lenient by design, skipping a key it cannot resolve so
 * that deleting a role does not take every membership naming it out of service.
 *
 * Lenient is right, and it is what made this silent: an owner resolved to no role at all and was
 * denied, and a denial for want of a record is indistinguishable from a denial by policy.
 */
describe('an organization owner holds a role that exists', () => {
    const all = BUILTIN_ROLES;

    it('resolves the roleKey both stores actually write', () => {
        // The probe that found it: an explicit grant to `owner`, and `permits` answering false
        // because there was no `owner` to hold it.
        const held = ['authenticated', 'owner'];
        const grants: readonly Grant[] = [{ roleKey: 'owner', contract: 'card.update' }];

        expect(permits({ held, all, grants }, 'card.update', 'org-1')).toBe(true);
    });

    it('is organization-scoped, so it grants nothing outside an organization', () => {
        // The other half of #26. Ownership is a fact about one organization; if this were
        // cluster-scoped, an owner of any organization would hold their grants everywhere.
        const held = ['owner'];
        const grants: readonly Grant[] = [{ roleKey: 'owner', contract: 'card.update' }];

        expect(permits({ held, all, grants }, 'card.update')).toBe(false);
        expect(permits({ held, all, grants }, 'card.update', 'org-1')).toBe(true);
    });

    it('may be a membership roleKey, which a cluster role may not', () => {
        // `createMembership` refuses a cluster-scoped key. Before F32 it would have refused `owner`
        // too — for the different and worse reason that the role did not exist.
        const owner = BUILTIN_ROLES.find((r) => r.key === 'owner');
        expect(owner?.scope).toBe('organization');
        expect(BUILTIN_ROLES.find((r) => r.key === 'operator')?.scope).toBe('cluster');
    });
});
