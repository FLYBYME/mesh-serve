/**
 * A `register(broker)`-shaped part -- unlike the manifest shape (`domains` + `handlers`),
 * synthesized at build time and thus already self-describing -- has never had to say what it
 * mounts. `unloadAndEvictModule` used to record `contracts: []` for one regardless, so stopping it
 * evicted the module but left every contract it registered still live on the broker; the next
 * start collided with them ("already mounted"). Found live composing a real site
 * (dns.site.yaml) out of two genuinely third-party register()-shaped services.
 *
 * The fix needs no cooperation from the part itself: `loadAndRegisterModule` now diffs
 * `broker.listContracts()` before and after calling `register(broker)`, and records whatever
 * appeared as the contract list -- the same information `loadDomain` already has, just filtered
 * after the fact instead of before. This proves the diff is real, not just that the code runs:
 * start, stop, start again, and confirm the second start succeeds instead of throwing "already
 * mounted", and that a stopped part's tool is genuinely gone in between.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext } from '@flybyme/mesh';

import { loadAndRegisterModule, unloadAndEvictModule, isPartLoaded } from '../src/catalog/methods/loadModule.js';

const DB_NAME = 'mesh-serve-register-shape-restart-test';
const FIXTURE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/register-shape/widget.ts',
);

describe('a register()-shaped part, stopped and started again', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let ctx: IServiceContext;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'register-shape-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        // Only `.broker` and `.nodeID` are read by loadAndRegisterModule/unloadAndEvictModule --
        // driving this through a real serve.part.start would need a real serve.repo/serve.part/
        // serve.artifact chain pointing at a built bundle, which is exactly the machinery this
        // test does not need: the bug is in the loader itself, reachable directly.
        ctx = { broker, nodeID: broker.nodeID } as IServiceContext;
    });

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('unmounts its contracts on unload, and can be loaded again without colliding', async () => {
        const first = await loadAndRegisterModule(ctx, FIXTURE_PATH);
        expect(first.domain).toBe('registerShapeWidget');

        // Really mounted, not just claimed to be.
        expect(broker.listContracts().some((c) => c.domain === 'registerShapeWidget' && c.action === 'create')).toBe(true);
        await expect(broker.call('registerShapeWidget.create' as never, { name: 'a' } as never, { meta: { tenant_id: 't1' } }))
            .resolves.toMatchObject({ name: 'a' });

        expect(isPartLoaded(ctx.nodeID, FIXTURE_PATH)).toBe(true);
        const unloaded = await unloadAndEvictModule(ctx, FIXTURE_PATH);

        // The real assertion: this used to be 0, always, for every register()-shaped part.
        expect(unloaded.contracts).toBeGreaterThan(0);
        // And the contracts it claims to have unmounted are actually gone.
        expect(broker.listContracts().some((c) => c.domain === 'registerShapeWidget')).toBe(false);
        await expect(broker.call('registerShapeWidget.create' as never, { name: 'b' } as never, { meta: { tenant_id: 't1' } }))
            .rejects.toThrow(/not found/i);

        // The real bug: a second load used to throw "already mounted" here, because the first
        // unload's `contracts: []` never actually unregistered anything.
        const second = await loadAndRegisterModule(ctx, FIXTURE_PATH);
        expect(second.domain).toBe('registerShapeWidget');
        await expect(broker.call('registerShapeWidget.create' as never, { name: 'c' } as never, { meta: { tenant_id: 't1' } }))
            .resolves.toMatchObject({ name: 'c' });

        await unloadAndEvictModule(ctx, FIXTURE_PATH);
    });
});
