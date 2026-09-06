/**
 * Roles as records — mesh-web spec/auth.md §5, roadmap C1.5 and C1.6.
 *
 * The point of these is not that a Set works. It is that the three properties the design claims are
 * actually properties: `public` is an ordinary role, grants only ever add, and a role's scope is
 * part of its identity so `admin` cannot mean two things.
 */

import { describe, expect, it } from 'vitest';

import {
    BUILTIN_ROLES, PUBLIC_ROLE, RoleSchema, grantCovers, permits, surfaceOf,
    type Grant, type Role,
} from '../../src/identity/index.js';

const publicRole = BUILTIN_ROLES.find((r) => r.key === PUBLIC_ROLE)!;
const authRole = BUILTIN_ROLES.find((r) => r.key === 'authenticated')!;
const authorRole: Role = { key: 'author', name: 'Author', scope: 'cluster', builtin: false };
const operatorRole: Role = { key: 'operator', name: 'Operator', scope: 'cluster', builtin: false };

const grants: readonly Grant[] = [
    { roleKey: PUBLIC_ROLE, contract: 'identity.register' },
    { roleKey: 'authenticated', contract: 'identity.whoami' },
    { roleKey: 'author', contract: 'post.*' },
    { roleKey: 'operator', contract: 'node.status' },
];

describe('public is a role like any other', () => {
    it('is what a caller with no ticket holds', () => {
        // Not a special case in the resolver: one path, and an anonymous caller simply holds the
        // role everyone holds.
        expect(permits([publicRole], grants, 'identity.register')).toBe(true);
        expect(permits([publicRole], grants, 'identity.whoami')).toBe(false);
    });

    it('ships with identity, and so does exactly one other role', () => {
        // A framework that shipped `editor` would be guessing at a blog, and one that shipped
        // `admin` would repeat the ambiguity in surfdns #26.
        expect(BUILTIN_ROLES.map((r) => r.key)).toEqual([PUBLIC_ROLE, 'authenticated']);
        // Only public is builtin (not deletable) — see roles.builtin comment and F8a
        expect(BUILTIN_ROLES.find((r) => r.key === PUBLIC_ROLE)?.builtin).toBe(true);
        expect(BUILTIN_ROLES.find((r) => r.key === 'authenticated')?.builtin).toBe(false);
    });

    it('grants nothing on its own by being authenticated', () => {
        // `authenticated` is a fact, not a permission. Holding it gets you whatever the deployment
        // granted it and no more.
        expect(permits([authRole], grants, 'post.list')).toBe(false);
    });
});

describe('grants add, and only add', () => {
    it('is the union of every role held', () => {
        expect(permits([publicRole, authorRole], grants, 'post.list')).toBe(true);
        expect(permits([publicRole, authorRole], grants, 'identity.register')).toBe(true);
    });

    it('denies anything nothing granted', () => {
        // Deny by default: there is no rule that says yes unless something says no.
        expect(permits([authorRole], grants, 'node.status')).toBe(false);
        expect(permits([], grants, 'identity.register')).toBe(false);
    });

    it('has no way for a role to take a permission away', () => {
        // A system where a role could *remove* one is a system where nobody can answer "what can
        // this person do" without evaluating order. Adding a role never shrinks the surface.
        const alone = surfaceOf([authorRole], grants);
        const withMore = surfaceOf([authorRole, publicRole, operatorRole], grants);

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
        expect(permits([authorRole], [{ roleKey: 'author', contract: '*' }], 'post.list')).toBe(false);
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
        expect(permits([clusterAdmin], testGrants, 'system.reboot')).toBe(true);
        expect(permits([clusterAdmin], testGrants, 'system.reboot', 'org-1')).toBe(true);

        // Org role grants only when acting in an organization
        expect(permits([orgAdmin], testGrants, 'org.settings')).toBe(false);
        expect(permits([orgAdmin], testGrants, 'org.settings', 'org-1')).toBe(true);
    });
});
