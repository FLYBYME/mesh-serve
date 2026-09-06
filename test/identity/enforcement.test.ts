/**
 * Enforcement tests for Track F roadmap items F3 and F8.
 *
 * Checks the three unread fields:
 * - Role.scope: cluster vs organization scoping in permits and write points
 * - roles.builtin: refusal to delete builtin roles with ClientError
 * - principals.ownerId: preventing an organization from being left unadministerable (surfdns #29)
 */

import { ClientError } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import {
    BUILTIN_ROLES,
    PUBLIC_ROLE,
    memoryStore,
    permits,
    type Grant,
    type Role,
} from '../../src/identity/index.js';

describe('F3: Role.scope enforcement', () => {
    const clusterRole: Role = {
        key: 'operator',
        name: 'Operator',
        scope: 'cluster',
        builtin: false,
    };

    const orgRole: Role = {
        key: 'editor',
        name: 'Editor',
        scope: 'organization',
        builtin: false,
    };

    const grants: readonly Grant[] = [
        { roleKey: 'operator', contract: 'system.reboot' },
        { roleKey: 'editor', contract: 'post.edit' },
    ];

    it('cluster role grants everywhere, including without organization', () => {
        expect(permits([clusterRole], grants, 'system.reboot')).toBe(true);
        expect(permits([clusterRole], grants, 'system.reboot', 'org-1')).toBe(true);
    });

    it('organization role does not grant outside an organization', () => {
        // Without an organization scope, an organization-scoped role must not grant
        expect(permits([orgRole], grants, 'post.edit')).toBe(false);
        // With an organization scope, it grants
        expect(permits([orgRole], grants, 'post.edit', 'org-1')).toBe(true);
    });

    it('refuses organization-scoped role in user.roles at creation', async () => {
        const store = memoryStore();
        await store.upsertRole(orgRole);

        await expect(
            store.createUser({
                email: 'user@example.com',
                displayName: 'User',
                roles: ['editor'],
            }),
        ).rejects.toThrow(ClientError);
    });

    it('refuses organization-scoped role in user.roles at update', async () => {
        const store = memoryStore();
        await store.upsertRole(orgRole);
        const user = await store.createUser({
            email: 'user@example.com',
            displayName: 'User',
            roles: [],
        });

        await expect(
            store.updateUser(user.id, { roles: ['editor'] }),
        ).rejects.toThrow(ClientError);
    });

    it('refuses cluster-scoped role as membership.roleKey', async () => {
        const store = memoryStore();
        await store.upsertRole(clusterRole);
        const user = await store.createUser({
            email: 'user@example.com',
            displayName: 'User',
            roles: [],
        });
        const org = await store.createOrganization({
            slug: 'acme',
            name: 'Acme',
            ownerId: user.id,
        });

        await expect(
            store.createMembership({
                userId: user.id,
                organizationId: org.id,
                roleKey: 'operator',
                joinedAt: Date.now(),
            }),
        ).rejects.toThrow(ClientError);
    });
});

describe('F8a: roles.builtin enforcement', () => {
    it('public role is builtin, authenticated is not', () => {
        const publicRole = BUILTIN_ROLES.find((r) => r.key === PUBLIC_ROLE);
        const authRole = BUILTIN_ROLES.find((r) => r.key === 'authenticated');

        expect(publicRole?.builtin).toBe(true);
        expect(authRole?.builtin).toBe(false);
    });

    it('refuses to delete a builtin role with ClientError naming the role and why', async () => {
        const store = memoryStore();
        for (const role of BUILTIN_ROLES) await store.upsertRole(role);

        let thrown: unknown;
        try {
            await store.deleteRole(PUBLIC_ROLE);
        } catch (err) {
            thrown = err;
        }

        expect(thrown).toBeInstanceOf(ClientError);
        if (thrown instanceof ClientError) {
            expect(thrown.message).toContain('public');
            expect(thrown.message).toMatch(/builtin/i);
        }
    });

    it('allows deleting a non-builtin role', async () => {
        const store = memoryStore();
        for (const role of BUILTIN_ROLES) await store.upsertRole(role);
        await store.upsertRole({
            key: 'custom',
            name: 'Custom',
            scope: 'cluster',
            builtin: false,
        });

        await store.deleteRole('custom');
        const roles = await store.listRoles();
        expect(roles.some((r) => r.key === 'custom')).toBe(false);
    });
});

describe('F8b: principals.ownerId enforcement (surfdns #29)', () => {
    it('an organization cannot be left unadministerable when the last owner leaves', async () => {
        const store = memoryStore();
        await store.upsertRole({ key: 'owner', name: 'Owner', scope: 'organization', builtin: false });

        const alice = await store.createUser({ email: 'alice@example.com', displayName: 'Alice', roles: [] });
        const bob = await store.createUser({ email: 'bob@example.com', displayName: 'Bob', roles: [] });

        const org = await store.createOrganization({ slug: 'acme', name: 'Acme', ownerId: alice.id });
        await store.createMembership({ userId: alice.id, organizationId: org.id, roleKey: 'owner', joinedAt: Date.now() });

        // Alice leaves the organization (removes membership)
        await store.deleteMembership(org.id, alice.id);

        // No memberships exist now
        const members = await store.membershipsOf(alice.id);
        expect(members.filter((m) => m.organizationId === org.id)).toHaveLength(0);

        // Bob (non-owner) cannot re-own it
        await expect(store.reownOrganization(org.id, bob.id)).rejects.toThrow(ClientError);

        // Alice (recorded in ownerId) CAN re-own it, restoring ownership
        const restored = await store.reownOrganization(org.id, alice.id);
        expect(restored.value.userId).toBe(alice.id);
        expect(restored.value.roleKey).toBe('owner');

        const activeMembers = await store.membershipsOf(alice.id);
        expect(activeMembers.some((m) => m.organizationId === org.id && m.roleKey === 'owner')).toBe(true);
    });

    it('transferring ownership is the only way ownerId changes', async () => {
        const store = memoryStore();
        await store.upsertRole({ key: 'owner', name: 'Owner', scope: 'organization', builtin: false });

        const alice = await store.createUser({ email: 'alice@example.com', displayName: 'Alice', roles: [] });
        const bob = await store.createUser({ email: 'bob@example.com', displayName: 'Bob', roles: [] });
        const charlie = await store.createUser({ email: 'charlie@example.com', displayName: 'Charlie', roles: [] });

        const org = await store.createOrganization({ slug: 'acme', name: 'Acme', ownerId: alice.id });
        await store.createMembership({ userId: alice.id, organizationId: org.id, roleKey: 'owner', joinedAt: Date.now() });

        // Charlie (not current owner) cannot transfer ownership
        await expect(store.transferOwnership(org.id, charlie.id, bob.id)).rejects.toThrow(ClientError);

        // Alice (current owner) can transfer ownership to Bob
        await store.transferOwnership(org.id, alice.id, bob.id);

        const updated = await store.getOrganization(org.id);
        expect(updated?.value.ownerId).toBe(bob.id);

        // Bob now has owner membership
        const bobMembers = await store.membershipsOf(bob.id);
        expect(bobMembers.some((m) => m.organizationId === org.id && m.roleKey === 'owner')).toBe(true);
    });
});
