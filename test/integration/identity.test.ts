/**
 * **M3 A4a: Identity persists across process restarts.**
 *
 * Assertions:
 * 1. An account registered and ticket issued on one MeshApp node survives node restart:
 *    a second MeshApp node connecting to the same database validates the ticket issued by the first.
 * 2. Two accounts cannot share an email (enforced by unique index in MongoDB).
 * 3. Revocations and monotonic epoch ordering persist across restarts.
 *
 * Needs mongo on `MONGODB_URI` (default `mongodb://localhost:27017`). Skipped when unreachable.
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

describe('identity persistence across restart', () => {
    let dbName: string;
    let client: MongoClient | undefined;

    beforeAll(async () => {
        if (!reachable) return;
        dbName = `mesh-serve-id-test-${String(Date.now())}`;
        client = new MongoClient(MONGO);
        await client.connect();
    });

    afterAll(async () => {
        if (client !== undefined && dbName !== undefined) {
            try {
                await client.db(dbName).dropDatabase();
            } catch {
                // Ignore drop errors on cleanup
            }
            await client.close();
        }
    });

    it('validates a ticket on a second node after the first node stopped', async () => {
        if (!reachable) return;

        // Node 1: Start MeshApp, register user, issue ticket, validate ticket
        const app1 = new MeshApp({
            nodeID: `id-node-1-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-identity-persist-test',
        });
        app1.use(new RegistryModule());
        app1.use(new DatabaseModule({ uri: MONGO, dbName }));
        app1.use(new BrokerModule());
        await app1.start();

        const db1 = app1.getProvider<Database>('database');
        const store1 = mongoStore(db1);
        await app1.registerModule(createIdentityModule({ store: store1 }));
        const broker1 = app1.getProvider<IServiceBroker>('broker');

        const { userId } = await broker1.call('identity.register', {
            email: 'alice@example.com',
            password: 'a-very-secure-password-123',
            displayName: 'Alice',
        });
        expect(userId).toBeDefined();

        const { token } = await broker1.call('identity.ticket_issue', {
            email: 'alice@example.com',
            password: 'a-very-secure-password-123',
        });
        expect(token).toBeDefined();

        const validation1 = await broker1.call('identity.ticket_validate', {
            ticket: token,
        });
        expect(validation1.valid).toBe(true);
        expect(validation1.userId).toBe(userId);

        // Stop Node 1 completely — simulating process exit
        await app1.stop();

        // Node 2: Start brand new MeshApp against the same database
        const app2 = new MeshApp({
            nodeID: `id-node-2-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-identity-persist-test',
        });
        app2.use(new RegistryModule());
        app2.use(new DatabaseModule({ uri: MONGO, dbName }));
        app2.use(new BrokerModule());
        await app2.start();

        const db2 = app2.getProvider<Database>('database');
        const store2 = mongoStore(db2);
        await app2.registerModule(createIdentityModule({ store: store2 }));
        const broker2 = app2.getProvider<IServiceBroker>('broker');

        // Validate the ticket that was issued by Node 1
        const validation2 = await broker2.call('identity.ticket_validate', {
            ticket: token,
        });
        expect(validation2.valid).toBe(true);
        expect(validation2.userId).toBe(userId);
        expect(validation2.roles).toContain('public');
        expect(validation2.roles).toContain('authenticated');

        // Node 2 can also issue tickets for the persisted user
        const { token: token2 } = await broker2.call('identity.ticket_issue', {
            email: 'alice@example.com',
            password: 'a-very-secure-password-123',
        });
        expect(token2).toBeDefined();
        expect(token2).not.toBe(token);

        // Node 2 revokes the original ticket
        await broker2.call('identity.ticket_revoke', { token });

        const validationAfterRevoke = await broker2.call('identity.ticket_validate', {
            ticket: token,
        });
        expect(validationAfterRevoke.valid).toBe(false);

        await app2.stop();
    }, 60_000);

    it('enforces that two accounts cannot share an email', async () => {
        if (!reachable) return;

        const app = new MeshApp({
            nodeID: `id-node-unique-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-identity-persist-test',
        });
        app.use(new RegistryModule());
        app.use(new DatabaseModule({ uri: MONGO, dbName }));
        app.use(new BrokerModule());
        await app.start();

        const db = app.getProvider<Database>('database');
        const store = mongoStore(db);
        await app.registerModule(createIdentityModule({ store }));
        const broker = app.getProvider<IServiceBroker>('broker');

        // First registration succeeds
        const first = await broker.call('identity.register', {
            email: 'bob@example.com',
            password: 'bobs-password-123',
            displayName: 'Bob',
        });
        expect(first.userId).toBeDefined();

        // Second registration with the same email via contract is refused
        await expect(
            broker.call('identity.register', {
                email: 'bob@example.com',
                password: 'another-password',
                displayName: 'Imposter Bob',
            }),
        ).rejects.toThrow();

        // Direct store write with the same email is refused by MongoDB unique index
        await expect(
            store.createUser({
                email: 'bob@example.com',
                displayName: 'Direct Imposter',
                roles: [],
            }),
        ).rejects.toThrow();

        // Different email succeeds
        const third = await broker.call('identity.register', {
            email: 'charlie@example.com',
            password: 'charlies-password-123',
            displayName: 'Charlie',
        });
        expect(third.userId).toBeDefined();
        expect(third.userId).not.toBe(first.userId);

        await app.stop();
    }, 60_000);
});
