/**
 * Unloading a part for real: unmount its contracts, stop what it owned, drop its module.
 *
 * The reason core parts are built as CommonJS and loaded with `require()` at all is this one
 * operation. An ES module cannot be dropped once evaluated -- it stays in the loader's registry for
 * the life of the process -- so a "reload" would silently hand back the same already-evaluated
 * module and nothing would change. `delete require.cache[...]` is the only mechanism that makes a
 * second load genuinely re-read the file.
 *
 * Three properties, and the third is the one that is easy to fake:
 *
 * 1. the contracts go away
 * 2. what the part *owned* stops -- a listener's port closes, a timer stops firing
 * 3. the module itself is gone, so the next load is a real load
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import { corePartPath } from '../src/catalog/methods/corePartPath.js';
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';
import '../src/catalog/contracts/corePart.contract.js';

const require = createRequire(import.meta.url);

const DB_NAME = 'mesh-serve-eviction-integration-test';
const WS_PORT = 16566;
const API_PORT = 15566;
const CDN_PORT = 13566;

const isCached = (name: 'identity' | 'cdn' | 'queue' | 'api' | 'hold'): boolean =>
    require.cache[require.resolve(corePartPath(name))] !== undefined;

describe('unloading a part, and evicting its module', () => {
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

        app = new MeshApp({ nodeID: 'eviction-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
    }, 30000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('refuses to unload something that is not loaded', async () => {
        await expect(broker.call('serve.corePart.unload', { name: 'hold' })).rejects.toThrow(/not running/i);
    });

    it('unmounts every contract the part had mounted', async () => {
        await broker.call('serve.corePart.load', { name: 'hold' });
        expect(broker.listContracts().map((c) => `${c.domain}.${c.action}`)).toContain('serve.hold.decide');

        const result = await broker.call('serve.corePart.unload', { name: 'hold' });
        expect(result.contracts).toBeGreaterThan(0);
        expect(result.domains).toContain('serve.hold');

        const mounted = broker.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mounted).not.toContain('serve.hold.decide');
        expect(mounted.some((k) => k.startsWith('serve.hold.'))).toBe(false);
    }, 20000);

    it('makes the contract genuinely uncallable afterwards', async () => {
        await broker.call('serve.corePart.load', { name: 'hold' });
        await broker.call('serve.hold.find', {}, { meta: { tenant_id: 't' } });

        await broker.call('serve.corePart.unload', { name: 'hold' });
        await expect(
            broker.call('serve.hold.find', {}, { meta: { tenant_id: 't' } }),
        ).rejects.toThrow(/not found|advertis/i);
    }, 20000);

    it('drops the module, so the next load is a real load', async () => {
        await broker.call('serve.corePart.load', { name: 'hold' });
        expect(isCached('hold')).toBe(true);

        const result = await broker.call('serve.corePart.unload', { name: 'hold' });
        expect(result.evicted).toBe(true);
        // The property the CJS decision exists for. Without this the next require() returns the
        // same evaluated module and "reloading" changes nothing.
        expect(isCached('hold')).toBe(false);
    }, 20000);

    it('can be loaded again after being unloaded, and works', async () => {
        await broker.call('serve.corePart.load', { name: 'hold' });
        await broker.call('serve.corePart.unload', { name: 'hold' });

        await broker.call('serve.corePart.load', { name: 'hold' });
        expect(isCached('hold')).toBe(true);

        const created = await broker.call('serve.hold.create', {
            tenantId: 'reload-tenant',
            call: 'identity.whoami',
            host: 'api.localhost',
            input: {},
            requestedBy: { userId: 'u1', roles: ['operator'] },
            status: 'held',
            requestedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        }, { meta: { tenant_id: 'reload-tenant' } });
        expect(created.id).toBeTruthy();

        await broker.call('serve.corePart.unload', { name: 'hold' });
    }, 25000);

    it('closes a listener the part owned -- ctx.signal, through unregisterContract', async () => {
        await broker.call('serve.corePart.load', { name: 'cdn' });
        const before = await fetch(`http://127.0.0.1:${CDN_PORT}/`).catch(() => undefined);
        expect(before).toBeDefined();

        // Nothing here stops the server. Unmounting serve.cdn.listen aborts its
        // registration-scoped signal, and the handler's own abort listener closes it.
        await broker.call('serve.corePart.unload', { name: 'cdn' });
        await new Promise((r) => { setTimeout(r, 250); });

        await expect(fetch(`http://127.0.0.1:${CDN_PORT}/`)).rejects.toThrow();
    }, 25000);

    it('stops an interval the part owned -- the timer, not just the contract', async () => {
        const meta = { meta: { tenant_id: 'evict-tenant' } };
        await broker.call('serve.corePart.load', { name: 'queue' });

        // First establish the loop is genuinely running, so the second half means something: a job
        // created here is claimed by serve.queue.tick within a few of its own periods.
        const claimed = await broker.call('serve.queue.create', {
            tenantId: 'evict-tenant', contract: 'serve.queue.find_one', payload: { query: { id: 'x' } },
            requestedBy: { userId: 'u' }, maxAttempts: 1, timeoutMs: 5000,
        }, meta);

        const deadline = Date.now() + 8000;
        let status = claimed.status;
        while (Date.now() < deadline && status === 'pending') {
            await new Promise((r) => { setTimeout(r, 150); });
            status = (await broker.call('serve.queue.get', { id: claimed.id }, meta)).status;
        }
        expect(status).not.toBe('pending');

        await broker.call('serve.corePart.unload', { name: 'queue' });

        // Now insert a pending job straight into the collection, behind the contracts that no
        // longer exist. A tick still running would claim it within a period or two.
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        const rows = client.db(DB_NAME).collection('serve.queue');
        const inserted = await rows.insertOne({
            tenantId: 'evict-tenant', contract: 'serve.queue.find_one', payload: { query: { id: 'y' } },
            requestedBy: { userId: 'u' }, status: 'pending', attempts: 0, maxAttempts: 1,
            timeoutMs: 5000, priority: 0, createdAt: new Date(), updatedAt: new Date(),
        });

        await new Promise((r) => { setTimeout(r, 2500); });
        const after = await rows.findOne({ _id: inserted.insertedId });
        await client.close();

        expect(after?.status).toBe('pending');
    }, 30000);
});
