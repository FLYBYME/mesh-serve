/**
 * A part reloaded in place must not leave its previous build running.
 *
 * Deploying is re-pinning a part to a new artifact; reconcile unloads the old build and loads the
 * new one on the same node. The loader already took back the contracts a `register(broker)` part
 * mounted (it snapshots `listContracts()`), but not what no list shows: an event handler stayed
 * subscribed after its module was evicted, so after a redeploy every event ran the old build's
 * handler *and* the new one's -- and after N redeploys, N+1 of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    BrokerModule, defineContract, defaultPrint, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { loadAndRegisterModule, unloadAndEvictModule } from '../src/catalog/methods/loadModule.js';

const heard: string[] = [];

declare global {
    interface EventRegistry {
        'partreload.ping': Record<string, never>;
    }
    interface IServiceToolRegistry {
        'partreload.load': { params: { modulePath: string }; returns: { domain: string } };
        'partreload.unload': { params: { modulePath: string }; returns: { contracts: number } };
    }
    // The built part records what it heard here; a real part would do real work.
    var partReloadHeard: string[] | undefined;
}

const loadContract = defineContract({
    domain: 'partreload', action: 'load', description: 'test: load a built part on this node',
    inputSchema: z.object({ modulePath: z.string() }), outputSchema: z.object({ domain: z.string() }),
    rest: { method: 'POST', path: '/partreload/load' }, filePath: 'test/partReload.integration.test.ts',
    concurrency: 'on-demand', permissions: [], print: defaultPrint,
});
const unloadContract = defineContract({
    domain: 'partreload', action: 'unload', description: 'test: unload a built part from this node',
    inputSchema: z.object({ modulePath: z.string() }), outputSchema: z.object({ contracts: z.number() }),
    rest: { method: 'POST', path: '/partreload/unload' }, filePath: 'test/partReload.integration.test.ts',
    concurrency: 'on-demand', permissions: [], print: defaultPrint,
});

/** One build of a `register(broker)` part: subscribes a handler that says which build it is. */
function writeBuild(dir: string, build: string): string {
    const file = path.join(dir, `part-${build}.cjs`);
    fs.writeFileSync(file, `
exports.register = function register(broker) {
    broker.registerEventHandler('partreload.ping', function () {
        (globalThis.partReloadHeard = globalThis.partReloadHeard || []).push(${JSON.stringify(build)});
    });
    return 'partreload-part';
};
`);
    return file;
}

describe('reloading a part in place', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let dir: string;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'part-reload-'));
        globalThis.partReloadHeard = heard;

        app = new MeshApp({ nodeID: 'part-reload-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 16577, '127.0.0.1')] }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        // Through contracts, so the loader gets the real IServiceContext a part start gives it.
        broker.registerContract(loadContract, async ({ modulePath }, ctx) => {
            const { domain } = await loadAndRegisterModule(ctx, modulePath);
            return { domain };
        });
        broker.registerContract(unloadContract, async ({ modulePath }, ctx) => {
            const { contracts } = await unloadAndEvictModule(ctx, modulePath);
            return { contracts };
        });
    }, 30000);

    afterAll(async () => {
        await app.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const ping = async (): Promise<void> => {
        broker.emit('partreload.ping', {}, { skipNetwork: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    it('runs only the new build\'s handler after a redeploy', async () => {
        const v1 = writeBuild(dir, 'v1');
        const v2 = writeBuild(dir, 'v2');

        await broker.call('partreload.load', { modulePath: v1 });
        await ping();
        expect(heard).toEqual(['v1']);

        // The redeploy: unload the old build, load the new one, same node.
        await broker.call('partreload.unload', { modulePath: v1 });
        await broker.call('partreload.load', { modulePath: v2 });
        heard.length = 0;
        await ping();

        expect(heard).toEqual(['v2']);
    });

    it('leaves nothing subscribed once the part is unloaded', async () => {
        const v3 = writeBuild(dir, 'v3');
        await broker.call('partreload.load', { modulePath: v3 });
        await broker.call('partreload.unload', { modulePath: path.join(dir, 'part-v2.cjs') });
        await broker.call('partreload.unload', { modulePath: v3 });
        heard.length = 0;

        await ping();

        expect(heard).toEqual([]);
    });
});
