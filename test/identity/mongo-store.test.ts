/**
 * **mongoStore tests: every method of IdentityStore against a real MongoDB database.**
 *
 * Verifies that mongoStore satisfies the IdentityStore interface and behaves with
 * the same invariants as memoryStore while persisting data to MongoDB.
 *
 * Needs mongo on `MONGODB_URI` (default `mongodb://localhost:27017`). Skipped when unreachable.
 */

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mongoStore, type IdentityStore } from '../../src/identity/index.js';
import type { Membership, Organization, User } from '../../src/identity/schema/principals.js';
import type { Role } from '../../src/identity/schema/roles.js';
import type { Ticket } from '../../src/identity/schema/tickets.js';

const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

describe('mongoStore', () => {
    let client: MongoClient | undefined;
    let dbName: string;
    let store: IdentityStore;

    beforeAll(async () => {
        if (!reachable) return;
        dbName = `mesh-serve-store-test-${String(Date.now())}`;
        client = new MongoClient(MONGO);
        await client.connect();
        store = mongoStore(client.db(dbName));
    });

    afterAll(async () => {
        if (client !== undefined && dbName !== undefined) {
            try {
                await client.db(dbName).dropDatabase();
            } catch {
                // Ignore cleanup errors
            }
            await client.close();
        }
    });

    describe('users', () => {
        it('creates, finds, gets, and updates users', async () => {
            if (!reachable) return;

            const user: User = {
                email: 'test-user@example.com',
                displayName: 'Test User',
                passwordHash: 'hash-123',
                roles: [],
            };

            const created = await store.createUser(user);
            expect(created.id).toBeDefined();
            expect(created.value.email).toBe(user.email);

            const byEmail = await store.findUserByEmail('test-user@example.com');
            expect(byEmail).toBeDefined();
            expect(byEmail?.id).toBe(created.id);
            expect(byEmail?.value.displayName).toBe('Test User');

            const byId = await store.getUser(created.id);
            expect(byId).toBeDefined();
            expect(byId?.id).toBe(created.id);

            await store.updateUser(created.id, { displayName: 'Updated User' });
            const updated = await store.getUser(created.id);
            expect(updated?.value.displayName).toBe('Updated User');
        });

        it('refuses creating a user with the same email (unique index)', async () => {
            if (!reachable) return;

            const user1: User = {
                email: 'unique-check@example.com',
                displayName: 'First',
                roles: [],
            };
            const user2: User = {
                email: 'unique-check@example.com',
                displayName: 'Second',
                roles: [],
            };

            await store.createUser(user1);
            await expect(store.createUser(user2)).rejects.toThrow();
        });

        it('refuses organization-scoped role on user.roles', async () => {
            if (!reachable) return;

            const orgRole: Role = {
                key: 'org-admin',
                name: 'Org Admin',
                scope: 'organization',
                builtin: false,
            };
            await store.upsertRole(orgRole);

            const invalidUser: User = {
                email: 'invalid-roles@example.com',
                displayName: 'Invalid',
                roles: ['org-admin'],
            };
            await expect(store.createUser(invalidUser)).rejects.toThrow();
        });
    });

    describe('organizations and memberships', () => {
        it('creates organization and manages ownership transfer and reowning', async () => {
            if (!reachable) return;

            const owner = await store.createUser({
                email: 'owner@example.com',
                displayName: 'Owner',
                roles: [],
            });
            const newOwner = await store.createUser({
                email: 'new-owner@example.com',
                displayName: 'New Owner',
                roles: [],
            });

            const org: Organization = {
                slug: 'acme-corp',
                name: 'Acme Corp',
                ownerId: owner.id,
            };
            const createdOrg = await store.createOrganization(org);
            expect(createdOrg.id).toBeDefined();

            const fetchedOrg = await store.getOrganization(createdOrg.id);
            expect(fetchedOrg?.value.slug).toBe('acme-corp');
            expect(fetchedOrg?.value.ownerId).toBe(owner.id);

            // Transfer ownership
            await store.transferOwnership(createdOrg.id, owner.id, newOwner.id);
            const transferred = await store.getOrganization(createdOrg.id);
            expect(transferred?.value.ownerId).toBe(newOwner.id);

            const newOwnerMemberships = await store.membershipsOf(newOwner.id);
            expect(newOwnerMemberships.some((m) => m.organizationId === createdOrg.id && m.roleKey === 'owner')).toBe(true);

            // Reown organization
            const reowned = await store.reownOrganization(createdOrg.id, newOwner.id);
            expect(reowned.value.roleKey).toBe('owner');
        });

        it('creates, lists, and deletes memberships', async () => {
            if (!reachable) return;

            const user = await store.createUser({
                email: 'member@example.com',
                displayName: 'Member',
                roles: [],
            });

            const role: Role = {
                key: 'member-role',
                name: 'Member Role',
                scope: 'organization',
                builtin: false,
            };
            await store.upsertRole(role);

            const membership: Membership = {
                userId: user.id,
                organizationId: 'org-test-123',
                roleKey: 'member-role',
                joinedAt: Date.now(),
            };

            const created = await store.createMembership(membership);
            expect(created.id).toBeDefined();

            const list = await store.membershipsOf(user.id);
            expect(list.length).toBe(1);
            expect(list[0]?.organizationId).toBe('org-test-123');

            await store.deleteMembership('org-test-123', user.id);
            const afterDelete = await store.membershipsOf(user.id);
            expect(afterDelete.length).toBe(0);
        });
    });

    describe('roles and grants', () => {
        it('upserts, lists, gets, and deletes non-builtin roles', async () => {
            if (!reachable) return;

            const role: Role = {
                key: 'custom-role',
                name: 'Custom Role',
                scope: 'cluster',
                description: 'A test custom role',
                builtin: false,
            };

            await store.upsertRole(role);
            const fetched = await store.getRole('custom-role');
            expect(fetched?.key).toBe('custom-role');
            expect(fetched?.description).toBe('A test custom role');

            const all = await store.listRoles();
            expect(all.some((r) => r.key === 'custom-role')).toBe(true);

            await store.deleteRole('custom-role');
            const deleted = await store.getRole('custom-role');
            expect(deleted).toBeUndefined();
        });

        it('refuses deletion of builtin roles', async () => {
            if (!reachable) return;

            const builtinRole: Role = {
                key: 'public',
                name: 'Public',
                scope: 'cluster',
                builtin: true,
            };
            await store.upsertRole(builtinRole);
            await expect(store.deleteRole('public')).rejects.toThrow();
        });

        it('adds and lists grants', async () => {
            if (!reachable) return;

            await store.addGrant({ roleKey: 'editor', contract: 'post.create' });
            await store.addGrant({ roleKey: 'editor', contract: 'post.update' });

            const grants = await store.listGrants();
            expect(grants.some((g) => g.roleKey === 'editor' && g.contract === 'post.create')).toBe(true);
            expect(grants.some((g) => g.roleKey === 'editor' && g.contract === 'post.update')).toBe(true);
        });
    });

    describe('tickets', () => {
        it('creates, retrieves, revokes, and lists live tickets', async () => {
            if (!reachable) return;

            const now = Date.now();
            const ticket: Ticket = {
                token: `tok-${String(Math.random()).slice(2, 10)}`,
                userId: 'user-ticket-test',
                roles: ['authenticated'],
                issuedAt: now,
                expiresAt: now + 3600_000,
                via: 'password',
            };

            await store.createTicket(ticket);
            const retrieved = await store.getTicket(ticket.token);
            expect(retrieved).toBeDefined();
            expect(retrieved?.token).toBe(ticket.token);
            expect(retrieved?.userId).toBe('user-ticket-test');

            const liveBefore = await store.liveTicketsOf('user-ticket-test');
            expect(liveBefore.length).toBe(1);

            await store.markRevoked(ticket.token, Date.now(), 'user logged out');
            const retrievedAfter = await store.getTicket(ticket.token);
            expect(retrievedAfter?.revokedAt).toBeDefined();
            expect(retrievedAfter?.revokedReason).toBe('user logged out');

            const liveAfter = await store.liveTicketsOf('user-ticket-test');
            expect(liveAfter.length).toBe(0);
        });
    });

    describe('revocations and epoch ordering', () => {
        it('allocates strictly monotonic epochs and queries ranges', async () => {
            if (!reachable) return;

            const rangeBefore = await store.epochRange();

            const e1 = await store.appendRevocation({
                kind: 'ticket',
                subject: 'token-abc',
                at: Date.now(),
                reason: 'compromised',
            });

            const e2 = await store.appendRevocation({
                kind: 'principal',
                subject: 'user-xyz',
                at: Date.now(),
                reason: 'suspended',
            });

            expect(e2).toBe(e1 + 1);

            const rangeAfter = await store.epochRange();
            expect(rangeAfter.newest).toBe(e2);
            expect(rangeAfter.oldest).toBeLessThanOrEqual(e1);

            const sinceE1 = await store.revocationsSince(e1, 10);
            expect(sinceE1.length).toBe(1);
            expect(sinceE1[0]?.epoch).toBe(e2);
            expect(sinceE1[0]?.subject).toBe('user-xyz');
        });
    });

    describe('api tokens', () => {
        it('creates and finds API tokens by hash', async () => {
            if (!reachable) return;

            const token = {
                tokenHash: 'sha256-hash-example',
                name: 'CI token',
                userId: 'user-ci',
                roles: ['authenticated'],
                createdAt: Date.now(),
            };

            const created = await store.createApiToken(token);
            expect(created.id).toBeDefined();
            expect(created.value.name).toBe('CI token');

            const found = await store.findApiToken('sha256-hash-example');
            expect(found).toBeDefined();
            expect(found?.value.userId).toBe('user-ci');
        });
    });
});
