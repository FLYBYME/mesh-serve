/**
 * A bare node that heals itself.
 *
 * `start` brings up the catalog kernel and nothing else. Before placement, a call for anything
 * outside it was an error, and something had to have known in advance to run a load sequence --
 * which is why `bootstrap` loads all five core parts up front, and why a second node joining an
 * existing cluster had no obvious way to become useful.
 *
 * Now the first call for a contract the node doesn't have loads the part implementing it. This
 * boots a node exactly as `start.ts` does, asserts nothing but the kernel is mounted, and then
 * makes one ordinary call.
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
import { createCorePartPlacement } from '../src/catalog/methods/corePartPlacement.js';
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';

const DB_NAME = 'mesh-serve-placement-integration-test';
const WS_PORT = 16559;
const API_PORT = 15559;
const CDN_PORT = 13559;

describe('a bare node, healing itself on demand', () => {
    let app: MeshApp;
    let broker: IServiceBroker;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        process.env.API_PORT = String(API_PORT);
        process.env.SERVER_PORT = String(CDN_PORT);

        app = new MeshApp({ nodeID: 'placement-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ ttl: 5000, implementation: PlacementRegistry }));
        app.use(new NetworkModule({
            transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')],
        }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());

        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        // Exactly what start.ts does, and nothing else: the kernel, then placement.
        for (const domain of CATALOG_DOMAINS) {
            await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        }
        broker.setPlacement(createCorePartPlacement(broker));
    }, 30000);

    afterAll(async () => {
        await app.stop();
    });

    it('has only the kernel mounted -- identity is genuinely not loaded', () => {
        const mounted = broker.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mounted).toContain('serve.repo.find');
        expect(mounted.some((k) => k.startsWith('identity.'))).toBe(false);
    });

    it('answers a call for an unloaded part by loading it first', async () => {
        // Nothing in this test loads identity. The call itself is what does it.
        const roles = await broker.call('identity.role.find', { query: {} });
        expect(roles).toEqual([]);

        const mounted = broker.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mounted).toContain('identity.role.find');
        expect(mounted).toContain('identity.whoami');
    }, 20000);

    it('places a sub-domain call against the part that owns the whole domain', async () => {
        // identity.user.* lives in the identity part, which the previous test already loaded --
        // so this also covers the "already mounted, no second placement" path.
        const user = await broker.call('identity.user.create', {
            email: 'placed@node.invalid', displayName: 'placed', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        expect(user.id).toBeTruthy();
    }, 20000);

    it('loads a different part on demand too, independently', async () => {
        const mountedBefore = broker.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mountedBefore.some((k) => k.startsWith('serve.hold.'))).toBe(false);

        await broker.call('serve.hold.find', {}, { meta: { tenant_id: 'placement-tenant' } });

        const mountedAfter = broker.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mountedAfter).toContain('serve.hold.decide');
    }, 20000);

    it('still fails honestly for a contract no part implements', async () => {
        await expect(
            broker.call('nonexistent.thing' as never, {} as never),
        ).rejects.toThrow();
    });
});
