/**
 * `onStart`: the contracts a service is asked to run once it is mounted -- how a `long-running`
 * contract (proxy.listen, dns.listen) gets started at all. Mounting a part calls none of them; the
 * api cannot aim a call at one node; a hand-run call did not survive a restart. Found putting the
 * proxy on port 80 and then trying to bring up two nameservers that each need their own dns.listen.
 *
 * Driven through `runOnStart` against a real broker and a real `register()`-shaped fixture, not
 * through `serve.part.start`: that handler ends in `ensureArtifactNodeModules`, which uses
 * `import.meta.resolve`, which vitest's transform does not implement (see roadmap: artifact
 * portability). The seam under test -- run the entries, and undo the start if one fails -- is
 * entirely in `runOnStart`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { BrokerModule, DatabaseModule, Logger, LogLevel, MeshApp, PlacementRegistry, RegistryModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext } from '@flybyme/mesh';

import { loadAndRegisterModule, isPartLoaded } from '../src/catalog/methods/loadModule.js';
import { markServiceRunning, getRunningService } from '../src/catalog/methods/services.js';
import { runOnStart } from '../src/catalog/methods/onStart.js';
import { openListeners } from './fixtures/on-start/listener.js';

const DB_NAME = 'mesh-serve-on-start-test';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/on-start/listener.ts');

describe('a service that declares onStart', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let ctx: IServiceContext;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'on-start-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        ctx = {
            broker,
            nodeID: broker.nodeID,
            call: (tool: never, params: never, options?: never) => broker.call(tool, params, options),
        } as unknown as IServiceContext;
    });

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    const mount = async (partId: string): Promise<void> => {
        const { domain } = await loadAndRegisterModule(ctx, FIXTURE);
        markServiceRunning(ctx.nodeID, partId, domain, FIXTURE);
    };

    it('calls each entry with its declared params, on the node that mounted the part', async () => {
        await mount('part-ok');
        expect(openListeners.size).toBe(0);          // mounted, and nothing listening yet

        await runOnStart(ctx, {
            id: 'part-ok',
            key: 'platform/ok',
            onStart: [{ contract: 'onStartProbe.listen', params: { port: 5301 } }],
        }, FIXTURE, {});

        expect([...openListeners]).toEqual([5301]);
        expect(getRunningService(ctx.nodeID, 'part-ok')).toBeDefined();
    });

    it('unloads the whole part when an entry fails, so nothing is left half-started', async () => {
        // Reset from the previous case: same fixture path, same node.
        const { unloadAndEvictModule } = await import('../src/catalog/methods/loadModule.js');
        await unloadAndEvictModule(ctx, FIXTURE);
        expect(openListeners.size).toBe(0);

        await mount('part-fail');

        await expect(runOnStart(ctx, {
            id: 'part-fail',
            key: 'platform/fail',
            onStart: [
                { contract: 'onStartProbe.listen', params: { port: 5302 } },
                { contract: 'onStartProbe.listen', params: { port: 5303, fail: true } },
            ],
        }, FIXTURE, {})).rejects.toThrow(/onStart "onStartProbe.listen" failed: .*5303.*in use.*retries the whole start/s);

        // The listener the first entry opened is closed again -- unregistering a long-running
        // contract aborts its signal -- not left bound by a part the supervisor thinks is down.
        expect(openListeners.size).toBe(0);
        expect(isPartLoaded(ctx.nodeID, FIXTURE)).toBe(false);
        expect(getRunningService(ctx.nodeID, 'part-fail')).toBeUndefined();
    });

    it('does nothing at all for a part with no onStart', async () => {
        await mount('part-plain');
        await runOnStart(ctx, { id: 'part-plain', key: 'platform/plain' }, FIXTURE, {});
        expect(openListeners.size).toBe(0);
        expect(getRunningService(ctx.nodeID, 'part-plain')).toBeDefined();
    });
});
