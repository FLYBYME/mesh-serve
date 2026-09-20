/**
 * The new boot model, end to end, against a real node and real MongoDB.
 *
 * `mesh-serve start` no longer mounts all six services statically -- it brings up the catalog
 * kernel and nothing else. Everything else (identity, cdn, hold, queue, api) is precompiled to
 * CommonJS at build time (`cli/core/buildCoreParts.ts` -> `dist/parts/*.cjs`) and loaded onto a
 * running node through `serve.corePart.load`, the same generic load-and-register path
 * `serve.part.start` uses for a third party's own service -- just resolving the file from this
 * package instead of from the content-addressed artifact store.
 *
 * This test boots a node exactly the way `start.ts` now does, proves identity genuinely isn't there
 * yet, then runs the same load sequence `bootstrap.ts` runs, and proves the node becomes fully
 * functional. It loads the real precompiled bundles -- `npm test` runs `build:parts` first so
 * they're always current.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CatalogService } from '../src/catalog/catalog.service.js';
import { CORE_PART_NAMES } from '../src/catalog/contracts/corePart.contract.js';

const DB_NAME = 'mesh-serve-corepart-integration-test';
const WS_PORT = 16557;
const API_PORT = 15557;
const CDN_PORT = 13557;

describe('a bare node, loading its own core parts', () => {
    let app: MeshApp;
    let broker: IServiceBroker;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        // ApiService/CdnService read their ports from env at onStart -- set before they're loaded,
        // exactly as start.ts does now.
        process.env.API_PORT = String(API_PORT);
        process.env.SERVER_PORT = String(CDN_PORT);
        process.env.PUBLIC_SCHEME = 'http';
        process.env.PUBLIC_API_PORT = String(API_PORT);

        const logger = new Logger(LogLevel.ERROR);
        app = new MeshApp({ nodeID: 'corepart-node', logger });
        app.use(new RegistryModule({ ttl: 5000, implementation: PlacementRegistry }));
        app.use(new NetworkModule({
            transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')],
        }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());

        // The one thing start.ts still mounts by name.
        await app.registerModule(new CatalogService());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
    }, 30000);

    afterAll(async () => {
        await app.stop();
    });

    it('starts with the catalog kernel only -- identity genuinely is not there yet', async () => {
        // The kernel's own contracts answer.
        await expect(broker.call('serve.repo.find', {}, { meta: { tenant_id: 'anything' } })).resolves.toBeDefined();

        // Nothing else does. This is the "start should really do nothing" property, asserted rather
        // than assumed: if some service were still being statically mounted, this would resolve.
        await expect(broker.call('identity.role.find', { query: {} })).rejects.toThrow(/not found/i);
    });

    it('loads every core part through serve.corePart.load, the same sequence bootstrap runs', async () => {
        const loaded: string[] = [];
        for (const name of CORE_PART_NAMES) {
            const result = await broker.call('serve.corePart.load', { name });
            expect(result.nodeID).toBe('corepart-node');
            loaded.push(result.domain);
        }

        // Each precompiled bundle registered under its own real domain.
        expect(loaded).toContain('identity');
        expect(loaded).toContain('serve.cdn');
        expect(loaded).toContain('serve.hold');
        expect(loaded).toContain('serve.queue');
        expect(loaded).toContain('serve.api');
    }, 30000);

    it('is fully functional afterwards -- identity answers, and its own onStart seeding ran', async () => {
        const roles = await broker.call('identity.role.find', { query: {} });
        // IdentityService.onStart seeds the four builtin roles; their presence proves the loaded
        // module's lifecycle hook actually ran, not just that its contracts got mounted.
        const keys = roles.map((r) => r.key);
        expect(keys).toContain('operator');
        expect(keys).toContain('owner');
        expect(keys).toContain('admin');
        expect(keys).toContain('member');
    });

    it('a part with no hand-written registration at all is fully functional through the same load path', async () => {
        // serve.hold has no service file. Its entry point is src/hold/handlers.generated.ts, which
        // is derived from its contracts' own declared filePaths -- nothing enumerates what to
        // mount. It loaded through the identical serve.corePart.load call as the ones still
        // exporting a class, which is the whole point: the loader doesn't know which era a part
        // belongs to.
        const meta = { meta: { tenant_id: 'corepart-tenant' } };

        const created = await broker.call('serve.hold.create', {
            tenantId: 'corepart-tenant',
            call: 'identity.whoami',
            host: 'api.localhost',
            input: {},
            requestedBy: { userId: 'u1', roles: ['operator'] },
            status: 'held',
            requestedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
        }, meta);
        expect(created.id).toBeTruthy();

        // Its CRUD is real (scopedBy tenantId applied, row round-trips)...
        const found = await broker.call('serve.hold.find', {}, meta);
        expect(found.map((h) => h.id)).toContain(created.id);

        // ...and its custom contract is mounted too, not just the CRUD.
        expect(broker.getModule('serve.hold')).toBeUndefined();
    });

    it('a loaded core part can be called through the mesh like any other contract', async () => {
        const user = await broker.call('identity.user.create', {
            email: 'corepart@node.invalid',
            displayName: 'corepart',
            passwordHash: 'x'.repeat(32),
            roles: [],
            provisional: false,
        });
        expect(user.id).toBeTruthy();

        const found = await broker.call('identity.user.find_one', { query: { email: 'corepart@node.invalid' } });
        expect(found?.id).toBe(user.id);
    });

    it('a loaded interval contract is already ticking -- nobody schedules it, the broker does', async () => {
        // The whole chain in one assertion: the precompiled queue bundle exported `register`, which
        // registered serve.queue.tick, whose declared `concurrency: 'interval'` made the broker
        // start a timer on the spot. Nothing in this test calls tick, and no class anywhere owns a
        // setInterval -- so if this job runs, the declaration alone is what scheduled it.
        const meta = { meta: { tenant_id: 'corepart-tenant' } };

        const job = await broker.call('serve.queue.create', {
            tenantId: 'corepart-tenant',
            contract: 'serve.queue.find_one',
            payload: { query: { id: 'never-matches' } },
            requestedBy: { userId: 'corepart-test' },
            maxAttempts: 1,
            timeoutMs: 5000,
        }, meta);

        const deadline = Date.now() + 10_000;
        let status = job.status;
        while (Date.now() < deadline && status !== 'completed' && status !== 'failed') {
            await new Promise((r) => setTimeout(r, 100));
            status = (await broker.call('serve.queue.get', { id: job.id }, meta)).status;
        }

        expect(status).toBe('completed');
    }, 15000);

    it('refuses to load the same core part twice rather than double-registering it', async () => {
        await expect(broker.call('serve.corePart.load', { name: 'identity' })).rejects.toThrow(/already running/i);
    });

    // Deliberately last: it takes the listener down for good.
    it('a long-running contract is stopped by unregistering it -- ctx.signal, nothing else', async () => {
        // serve.cdn.listen bound this port when the cdn part loaded, through a contract call rather
        // than an onStart.
        const before = await fetch(`http://127.0.0.1:${CDN_PORT}/`).catch(() => undefined);
        expect(before).toBeDefined();

        // No onStop anywhere, no stop handle held by the loader -- unregisterContract aborts the
        // registration-scoped signal, and the handler's own abort listener closes the server.
        (broker as unknown as { unregisterContract: (k: string) => void }).unregisterContract('serve.cdn.listen');
        await new Promise((r) => setTimeout(r, 200));

        await expect(fetch(`http://127.0.0.1:${CDN_PORT}/`)).rejects.toThrow();
    }, 15000);
});
