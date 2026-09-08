/**
 * **A4: Identity on defineCrud integration tests.**
 *
 * Tests:
 * 1. Tenant scoping on `membership`:
 *    - A caller in organization A cannot read organization B's memberships via `membership.find`.
 *    - A caller in organization A fetching organization B's membership via `membership.get` answers 404.
 *    - A caller in organization A cannot resolve organization B's membership via `membership.find_one`.
 *    - An unscoped caller calling `membership.find` answers 401 UNAUTHORIZED.
 * 2. Sign-in and registration for a caller with NO organization (D3a avoidance):
 *    - `identity.register` succeeds without organization context.
 *    - `identity.ticket_issue` succeeds without organization context.
 *    - `identity.ticket_validate` succeeds without organization context.
 *    - `identity.sign_out` succeeds without organization context.
 * 3. Unscoped read in `whoami`:
 *    - An authenticated user calling `identity.whoami` with no organization context discovers their
 *      memberships across organizations.
 * 4. Internal global CRUD:
 *    - `user.find`, `organization.find`, `role.find` answer for internal mesh callers.
 */

import {
    BrokerModule, DatabaseModule, MeshApp, RegistryModule, type Database, type IServiceBroker,
} from '@flybyme/mesh';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIdentityModule, mongoStore } from '../../src/identity/index.js';

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

describe('identity on defineCrud', () => {
    let client: MongoClient | undefined;
    let dbName: string;
    let app: MeshApp;
    let broker: IServiceBroker;

    const orgAMeta = { meta: { organizationId: 'org-alpha' } };
    const orgBMeta = { meta: { organizationId: 'org-beta' } };

    beforeAll(async () => {
        if (!reachable) return;
        dbName = `mesh-serve-crud-test-${String(Date.now())}`;
        client = new MongoClient(MONGO);
        await client.connect();

        app = new MeshApp({
            nodeID: `crud-node-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-identity-crud-test',
        });
        app.use(new RegistryModule());
        app.use(new DatabaseModule({ uri: MONGO, dbName }));
        app.use(new BrokerModule());
        await app.start();

        const db = app.getProvider<Database>('database');
        const store = mongoStore(db);
        await app.registerModule(createIdentityModule({ store }));
        broker = app.getProvider<IServiceBroker>('broker');
    });

    afterAll(async () => {
        if (app !== undefined) {
            await app.stop();
        }
        if (client !== undefined && dbName !== undefined) {
            try {
                await client.db(dbName).dropDatabase();
            } catch {
                // Ignore drop errors on cleanup
            }
            await client.close();
        }
    });

    describe('membership tenant scoping (D3)', () => {
        it('confines membership.find to caller organization', async () => {
            if (!reachable) return;

            // Create membership for user-1 in org-alpha
            await broker.call('membership.create', {
                userId: 'user-1',
                organizationId: 'org-alpha',
                roleKey: 'member',
                joinedAt: Date.now(),
            }, orgAMeta);

            // Create membership for user-2 in org-beta
            await broker.call('membership.create', {
                userId: 'user-2',
                organizationId: 'org-beta',
                roleKey: 'member',
                joinedAt: Date.now(),
            }, orgBMeta);

            // Caller in org-alpha finds memberships: only sees org-alpha
            const alphaMemberships = await broker.call('membership.find', {}, orgAMeta);
            expect(alphaMemberships.length).toBe(1);
            expect(alphaMemberships[0]?.userId).toBe('user-1');
            expect(alphaMemberships[0]?.organizationId).toBe('org-alpha');

            // Caller in org-beta finds memberships: only sees org-beta
            const betaMemberships = await broker.call('membership.find', {}, orgBMeta);
            expect(betaMemberships.length).toBe(1);
            expect(betaMemberships[0]?.userId).toBe('user-2');
            expect(betaMemberships[0]?.organizationId).toBe('org-beta');
        });

        it('returns 404 on membership.get across tenant boundaries', async () => {
            if (!reachable) return;

            // Get beta membership ID
            const betaMemberships = await broker.call('membership.find', {}, orgBMeta);
            const betaMembership = betaMemberships[0];
            expect(betaMembership).toBeDefined();
            if (betaMembership === undefined) return;

            // Caller in org-beta can fetch it
            const fetched = await broker.call('membership.get', { id: betaMembership.id }, orgBMeta);
            expect(fetched.id).toBe(betaMembership.id);

            // Caller in org-alpha fetching org-beta membership receives 404 NOT_FOUND
            let statusCode: number | undefined;
            try {
                await broker.call('membership.get', { id: betaMembership.id }, orgAMeta);
            } catch (err: unknown) {
                if (typeof err === 'object' && err !== null && 'status' in err) {
                    const statusObj = err as Record<string, unknown>;
                    if (typeof statusObj['status'] === 'number') {
                        statusCode = statusObj['status'];
                    }
                }
            }
            expect(statusCode).toBe(404);
        });

        it('returns undefined on membership.find_one across tenant boundaries', async () => {
            if (!reachable) return;

            // Caller in org-alpha querying for user-2 (in org-beta) returns undefined
            const found = await broker.call('membership.find_one', {
                query: { userId: 'user-2' },
            }, orgAMeta);
            expect(found).toBeUndefined();
        });

        it('refuses unscoped membership.find with 401 UNAUTHORIZED', async () => {
            if (!reachable) return;

            let statusCode: number | undefined;
            try {
                await broker.call('membership.find', {}, { meta: {} });
            } catch (err: unknown) {
                if (typeof err === 'object' && err !== null && 'status' in err) {
                    const statusObj = err as Record<string, unknown>;
                    if (typeof statusObj['status'] === 'number') {
                        statusCode = statusObj['status'];
                    }
                }
            }
            expect(statusCode).toBe(401);
        });
    });

    describe('sign-in and authentication without organization (D3a avoidance)', () => {
        it('allows register, ticket_issue, ticket_validate, and sign_out with no organization', async () => {
            if (!reachable) return;

            // 1. Register with no organization context
            const reg = await broker.call('identity.register', {
                email: 'carol@example.com',
                password: 'correct-horse-battery-staple',
                displayName: 'Carol Danvers',
            });
            expect(reg.userId).toBeDefined();

            // 2. Issue ticket with no organization context
            const issued = await broker.call('identity.ticket_issue', {
                email: 'carol@example.com',
                password: 'correct-horse-battery-staple',
            });
            expect(issued.token).toBeDefined();
            expect(issued.userId).toBe(reg.userId);

            // 3. Validate ticket with no organization context
            const val = await broker.call('identity.ticket_validate', {
                ticket: issued.token,
            });
            expect(val.valid).toBe(true);
            if (val.valid) {
                expect(val.userId).toBe(reg.userId);
                expect(val.roles).toContain('public');
                expect(val.roles).toContain('authenticated');
            }

            // 4. Sign out with no organization context
            const out = await broker.call('identity.sign_out', {
                token: issued.token,
            });
            expect(out.signedOut).toBe(true);
        });

        it('allows whoami with ticket but no active organization context to discover memberships', async () => {
            if (!reachable) return;

            // Register Dave
            const reg = await broker.call('identity.register', {
                email: 'dave@example.com',
                password: 'daves-password-1234',
                displayName: 'Dave Bowman',
            });

            // Create organization
            const org = await broker.call('organization.create', {
                name: 'Discovery Mission',
                slug: 'discovery-mission',
                ownerId: reg.userId,
            });

            // Add membership for Dave in the organization
            await broker.call('membership.create', {
                userId: reg.userId,
                organizationId: org.id,
                roleKey: 'owner',
                joinedAt: Date.now(),
            }, { meta: { organizationId: org.id } });

            // Call whoami with user context only (no organizationId on meta)
            const identity = await broker.call('identity.whoami', {}, {
                meta: { user: { id: reg.userId, tenant_id: '' } },
            });

            expect(identity.userId).toBe(reg.userId);
            expect(identity.email).toBe('dave@example.com');
            expect(identity.organizations.length).toBe(1);
            expect(identity.organizations[0]?.organizationId).toBe(org.id);
            expect(identity.organizations[0]?.name).toBe('Discovery Mission');
        });
    });

    describe('internal CRUD on global identity collections', () => {
        it('queries users, organizations, and roles via generated CRUD', async () => {
            if (!reachable) return;

            const users = await broker.call('user.find', {});
            expect(users.length).toBeGreaterThanOrEqual(2);

            const orgs = await broker.call('organization.find', {});
            expect(orgs.length).toBeGreaterThanOrEqual(1);

            const roles = await broker.call('role.find', {});
            expect(roles.length).toBeGreaterThanOrEqual(2);
            expect(roles.map((r) => r.key)).toContain('public');
            expect(roles.map((r) => r.key)).toContain('authenticated');
        });
    });

    describe('organization tenant scoping (Option b)', () => {
        let org1: { id: string; name: string; slug: string };
        let org2: { id: string; name: string; slug: string };
        let userOrg1Id: string;
        let userOrg2Id: string;
        let userNoOrgId: string;

        const user1Meta = () => ({ meta: { user: { id: userOrg1Id, tenant_id: org1.id } } });
        const user2Meta = () => ({ meta: { user: { id: userOrg2Id, tenant_id: org2.id } } });
        const noOrgMeta = () => ({ meta: { user: { id: userNoOrgId, tenant_id: '' } } });

        beforeAll(async () => {
            if (!reachable) return;

            // Register 3 users
            const u1 = await broker.call('identity.register', {
                email: 'tenant1-user@example.com',
                password: 'password-1234',
                displayName: 'Tenant 1 User',
            });
            userOrg1Id = u1.userId;

            const u2 = await broker.call('identity.register', {
                email: 'tenant2-user@example.com',
                password: 'password-1234',
                displayName: 'Tenant 2 User',
            });
            userOrg2Id = u2.userId;

            const u3 = await broker.call('identity.register', {
                email: 'no-org-user@example.com',
                password: 'password-1234',
                displayName: 'No Org User',
            });
            userNoOrgId = u3.userId;

            // Create two distinct organizations (internal calls)
            org1 = await broker.call('organization.create', {
                name: 'Tenant Alpha Org',
                slug: `alpha-org-${String(Date.now())}`,
                ownerId: userOrg1Id,
            });

            org2 = await broker.call('organization.create', {
                name: 'Tenant Beta Org',
                slug: `beta-org-${String(Date.now())}`,
                ownerId: userOrg2Id,
            });

            // Create memberships connecting user1 -> org1, user2 -> org2
            await broker.call('membership.create', {
                userId: userOrg1Id,
                organizationId: org1.id,
                roleKey: 'member',
                joinedAt: Date.now(),
            }, { meta: { organizationId: org1.id } });

            await broker.call('membership.create', {
                userId: userOrg2Id,
                organizationId: org2.id,
                roleKey: 'member',
                joinedAt: Date.now(),
            }, { meta: { organizationId: org2.id } });
        });

        it('confines organization.find to caller memberships', async () => {
            if (!reachable) return;

            // Caller in Org 1 only sees Org 1
            const orgsUser1 = await broker.call('organization.find', {}, user1Meta());
            expect(orgsUser1.length).toBe(1);
            expect(orgsUser1[0]?.id).toBe(org1.id);
            expect(orgsUser1[0]?.name).toBe('Tenant Alpha Org');

            // Caller in Org 2 only sees Org 2
            const orgsUser2 = await broker.call('organization.find', {}, user2Meta());
            expect(orgsUser2.length).toBe(1);
            expect(orgsUser2[0]?.id).toBe(org2.id);
            expect(orgsUser2[0]?.name).toBe('Tenant Beta Org');

            // Caller with no memberships sees 0 rows
            const orgsNoUser = await broker.call('organization.find', {}, noOrgMeta());
            expect(orgsNoUser.length).toBe(0);
        });

        it('returns 0 rows when caller in Org 1 queries for Org 2 ID via query filter', async () => {
            if (!reachable) return;

            // Specific query for Org 2 by Org 1 user returns empty array
            const forbiddenQuery = await broker.call('organization.find', {
                query: { id: org2.id },
            }, user1Meta());
            expect(forbiddenQuery.length).toBe(0);

            // Allowed query returns the document
            const allowedQuery = await broker.call('organization.find', {
                query: { id: org1.id },
            }, user1Meta());
            expect(allowedQuery.length).toBe(1);
            expect(allowedQuery[0]?.id).toBe(org1.id);
        });

        it('returns 404 on organization.get across tenant boundaries', async () => {
            if (!reachable) return;

            // User 1 fetching Org 1 succeeds
            const fetched = await broker.call('organization.get', { id: org1.id }, user1Meta());
            expect(fetched.id).toBe(org1.id);

            // User 1 fetching Org 2 receives 404 NOT_FOUND
            let statusCode: number | undefined;
            try {
                await broker.call('organization.get', { id: org2.id }, user1Meta());
            } catch (err: unknown) {
                if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
                    statusCode = err.status;
                }
            }
            expect(statusCode).toBe(404);
        });

        it('returns undefined on organization.find_one across tenant boundaries', async () => {
            if (!reachable) return;

            // User 1 querying for Org 2 returns undefined
            const found = await broker.call('organization.find_one', {
                query: { id: org2.id },
            }, user1Meta());
            expect(found).toBeUndefined();

            // User 1 querying for Org 1 returns Org 1
            const foundOwn = await broker.call('organization.find_one', {
                query: { id: org1.id },
            }, user1Meta());
            expect(foundOwn?.id).toBe(org1.id);
        });

        it('confines organization.count to caller memberships', async () => {
            if (!reachable) return;

            const count1 = await broker.call('organization.count', {}, user1Meta());
            expect(count1).toBe(1);

            const countNone = await broker.call('organization.count', {}, noOrgMeta());
            expect(countNone).toBe(0);
        });

        it('stamps ownerId and adds owner membership on organization.create by authenticated caller', async () => {
            if (!reachable) return;

            const newSlug = `new-org-${String(Date.now())}`;
            // `ownerId` is required by OrganizationSchema and names somebody else here on purpose:
            // the caller must not be able to create an organization owned by another user, so the
            // hook overwrites whatever arrives rather than only filling in a missing value.
            const created = await broker.call('organization.create', {
                name: 'Brand New Org',
                slug: newSlug,
                ownerId: 'somebody-else',
            }, user1Meta());

            expect(created.ownerId).toBe(userOrg1Id);

            // User 1 now sees 2 organizations
            const user1Orgs = await broker.call('organization.find', {}, user1Meta());
            expect(user1Orgs.map((o) => o.id)).toContain(created.id);

            // User 2 still only sees Org 2
            const user2Orgs = await broker.call('organization.find', {}, user2Meta());
            expect(user2Orgs.map((o) => o.id)).not.toContain(created.id);
        });

        it('refuses unauthenticated organization calls with 401 UNAUTHORIZED', async () => {
            if (!reachable) return;

            let findStatus: number | undefined;
            try {
                await broker.call('organization.find', {}, { meta: { user: undefined } });
            } catch (err: unknown) {
                if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
                    findStatus = err.status;
                }
            }
            expect(findStatus).toBe(401);

            let getStatus: number | undefined;
            try {
                await broker.call('organization.get', { id: org1.id }, { meta: { user: undefined } });
            } catch (err: unknown) {
                if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
                    getStatus = err.status;
                }
            }
            expect(getStatus).toBe(401);
        });
    });
});
