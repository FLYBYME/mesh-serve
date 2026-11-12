/**
 * identity.organization.rename: an owner or admin renames their own organization, its name only; a
 * member, or someone outside it, cannot.
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

const DB_NAME = 'mesh-serve-rename-organization-test';

const as = (userId: string, organizationId: string): { meta: { user: { id: string; tenant_id: string; organizationId: string } } } =>
    ({ meta: { user: { id: userId, tenant_id: organizationId, organizationId } } });

describe('identity.organization.rename', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'rename-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        for (const key of ['ann', 'bob', 'cat']) {
            const user = await broker.call('identity.user.create', { email: `${key}@rename.invalid`, displayName: key, passwordHash: 'x', roles: [], provisional: false });

            ids[key] = user.id;
        }

        const org = await broker.call('identity.organization.create', { slug: 'devops', name: 'devops', ownerId: ids['ann'] ?? '' });
        const other = await broker.call('identity.organization.create', { slug: 'other', name: 'Other', ownerId: ids['cat'] ?? '' });

        ids['org'] = org.id;
        ids['other'] = other.id;

        await broker.call('identity.membership.create', { userId: ids['bob'] ?? '', organizationId: org.id, roleKey: 'member', joinedAt: new Date() }, as(ids['bob'] ?? '', org.id));
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('renames the owner\'s organization, its name only', async () => {
        const answer = await broker.call('identity.organization.rename', { name: 'Development' }, as(ids['ann'] ?? '', ids['org'] ?? ''));

        expect(answer).toEqual({ organizationId: ids['org'], name: 'Development', was: 'devops' });

        const now = await broker.call('identity.organization.get', { id: ids['org'] ?? '' });

        expect({ name: now?.name, slug: now?.slug }).toEqual({ name: 'Development', slug: 'devops' });
    });

    it('refuses a member, and anyone outside it', async () => {
        await expect(broker.call('identity.organization.rename', { name: 'Mine' }, as(ids['bob'] ?? '', ids['org'] ?? ''))).rejects.toThrow(/owner or admin/);
        await expect(broker.call('identity.organization.rename', { name: 'Mine' }, as(ids['cat'] ?? '', ids['org'] ?? ''))).rejects.toThrow(/owner or admin/);

        expect((await broker.call('identity.organization.get', { id: ids['other'] ?? '' }))?.name).toBe('Other');
    });
});
