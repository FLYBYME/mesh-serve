/**
 * An operator deletes a site, a composition or a part -- but not one something still uses. Before
 * v0.10.83 none of the three could be deleted through the api at all (their delete was internal),
 * so a site moved to another host left its old records behind for good.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import { compositionCrud } from '../src/catalog/contracts/composition.contract.js';
import { partCrud } from '../src/catalog/contracts/part.contract.js';
import { siteCrud } from '../src/cdn/contracts/site.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-catalog-delete-integration-test';
const WS = 16614;
const ORG_SLUG = 'del-org';

describe('deleting a site, a composition or a part', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let tenantId = '';

    const meta = (): { meta: { tenant_id: string } } => ({ meta: { tenant_id: tenantId } });

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'delete-a', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.cdn', {}, { resolve: resolveHandler });

        const owner = await broker.call('identity.user.create', {
            email: 'delete@node.invalid', displayName: 'Delete', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        const org = await broker.call('identity.organization.create', { slug: ORG_SLUG, name: 'Delete', ownerId: owner.id });
        tenantId = org.id;
    }, 40000);

    afterAll(async () => {
        await app?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    async function newPart(name: string, kind: 'application' | 'service' = 'application'): Promise<{ id: string; key: string }> {
        const repo = await broker.call('serve.repo.create', {
            tenantId, name: `${name}-repo`, url: `/tmp/nonexistent-${name}.git`, defaultBranch: 'master',
        }, meta());

        return broker.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/${name}`, kind, path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta());
    }

    async function newComposition(key: string, applications: string[]): Promise<{ id: string }> {
        return broker.call('serve.composition.create', {
            tenantId, key, kernelPartKey: 'kernel-elsewhere', drivers: [], extensions: [], applications, services: [],
        }, meta());
    }

    async function newSite(host: string, application: string): Promise<{ id: string }> {
        return broker.call('serve.cdn.create', {
            tenantId, host, application, policy: {}, open: [], theme: {}, title: host, description: '',
            indexable: true, maintenance: false,
        }, meta());
    }

    it('the three deletes are public, for the api to expose to operators', () => {
        expect(partCrud.delete.visibility).toBe('public');
        expect(compositionCrud.delete.visibility).toBe('public');
        expect(siteCrud.delete.visibility).toBe('public');
    });

    it('refuses a part a composition names, by id or by key, and deletes it once nothing does', async () => {
        const byId = await newPart('by-id');
        const byKey = await newPart('by-key');
        const composition = await newComposition('del-app', [byId.id, byKey.key]);

        await expect(broker.call('serve.part.delete', { id: byId.id }, meta())).rejects.toThrow(/in composition "del-app"/);
        await expect(broker.call('serve.part.delete', { id: byKey.id }, meta())).rejects.toThrow(/in composition "del-app"/);
        expect(await broker.call('serve.part.get', { id: byId.id }, meta())).toMatchObject({ id: byId.id });

        await broker.call('serve.composition.delete', { id: composition.id }, meta());
        await broker.call('serve.part.delete', { id: byId.id }, meta());
        await broker.call('serve.part.delete', { id: byKey.id }, meta());

        expect(await broker.call('serve.part.find', { query: { key: { $in: [byId.key, byKey.key] } } }, meta())).toEqual([]);
    });

    it('refuses a service part meant to be running', async () => {
        const service = await newPart('running', 'service');
        await broker.call('serve.part.update', { id: service.id, desired: 'running' }, meta());

        await expect(broker.call('serve.part.delete', { id: service.id }, meta())).rejects.toThrow(/meant to be running/);

        await broker.call('serve.part.update', { id: service.id, desired: 'stopped' }, meta());
        await broker.call('serve.part.delete', { id: service.id }, meta());
    });

    it('refuses a composition a site serves, and deletes it once the site is gone', async () => {
        const composition = await newComposition('served-app', []);
        const site = await newSite('served.localhost', 'served-app');

        await expect(broker.call('serve.composition.delete', { id: composition.id }, meta())).rejects.toThrow(/served by served\.localhost/);

        await broker.call('serve.cdn.delete', { id: site.id }, meta());
        await broker.call('serve.composition.delete', { id: composition.id }, meta());

        expect(await broker.call('serve.composition.find', { query: { key: 'served-app' } }, meta())).toEqual([]);
        expect(await broker.call('serve.cdn.find', { query: { host: 'served.localhost' } }, meta())).toEqual([]);
    });
});
