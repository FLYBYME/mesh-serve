/**
 * identity.people: the people of the caller's own organization, by name, and no other's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { BrokerModule, DatabaseModule, Logger, LogLevel, MeshApp, PlacementRegistry, RegistryModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-people-integration-test';

const as = (userId: string, organizationId: string): { meta: { user: { id: string; tenant_id: string; organizationId: string } } } =>
    ({ meta: { user: { id: userId, tenant_id: organizationId, organizationId } } });

describe('identity.people', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'people-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        for (const { key, name } of [{ key: 'ann', name: 'Ann Lee' }, { key: 'bob', name: 'Bob Roy' }, { key: 'cat', name: 'Cat Day' }]) {
            const user = await broker.call('identity.user.create', { email: `${key}@people.invalid`, displayName: name, passwordHash: 'x', roles: [], provisional: false });

            ids[key] = user.id;
        }

        const orgA = await broker.call('identity.organization.create', { slug: 'org-a', name: 'A', ownerId: ids['ann'] ?? '' });
        const orgB = await broker.call('identity.organization.create', { slug: 'org-b', name: 'B', ownerId: ids['cat'] ?? '' });

        ids['orgA'] = orgA.id;
        ids['orgB'] = orgB.id;

        await broker.call('identity.membership.create', { userId: ids['bob'] ?? '', organizationId: orgA.id, roleKey: 'member', joinedAt: new Date() }, as(ids['bob'] ?? '', orgA.id));
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('tells a member who is in their organization, by name, email and role', async () => {
        const answer = await broker.call('identity.people', {}, as(ids['bob'] ?? '', ids['orgA'] ?? ''));

        expect(answer.people).toEqual([
            { id: ids['ann'], name: 'Ann Lee', email: 'ann@people.invalid', role: 'owner' },
            { id: ids['bob'], name: 'Bob Roy', email: 'bob@people.invalid', role: 'member' },
        ]);
    });

    it('tells nobody outside the organization', async () => {
        await expect(broker.call('identity.people', {}, as(ids['cat'] ?? '', ids['orgA'] ?? ''))).rejects.toThrow(/own members/);

        const theirs = await broker.call('identity.people', {}, as(ids['cat'] ?? '', ids['orgB'] ?? ''));

        expect(theirs.people.map((p) => p.name)).toEqual(['Cat Day']);
    });
});
