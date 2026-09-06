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
});
