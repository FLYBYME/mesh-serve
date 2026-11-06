/**
 * A part reloaded in place must give back the old build's memory.
 *
 * 11-06: core's heap grew ~18 MB with each compute deploy (11-04 07:03-08:57Z, six deploys, 250 ->
 * 360 MB) and never came back; flat at 360 MB (limit ~393) for 18 h, it died 11-05 03:29Z. Compute
 * runs on core as `register.cjs`, which unloadAndEvictModule drops from require's cache and its
 * parent's children (10-15: that alone freed a plain 20 MB part). So something else still holds
 * an old copy: a reference the part handed to the broker or to the shared @flybyme/mesh.
 *
 * Each case below is one way a part hooks in, carrying 20 MB of its own (module-scope ballast its
 * handlers close over). It is loaded and unloaded RELOADS times, the heap collected, and what it
 * kept read: a build given back keeps ~nothing; one held keeps ~20 MB a reload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, defineContract, defineCrud, defaultPrint, JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule, PlacementRegistry, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { loadAndRegisterModule, unloadAndEvictModule } from '../src/catalog/methods/loadModule.js';

const RELOADS = 8;
const BALLAST_MB = 20;
const DB_NAME = 'mesh-serve-part-reload-heap';
const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';

declare global {
    interface IServiceToolRegistry {
        'reloadheap.load': { params: { modulePath: string }; returns: { domain: string } };
        'reloadheap.unload': { params: { modulePath: string }; returns: { contracts: number } };
    }
    // What a built part would import from @flybyme/mesh: a build in a temp folder cannot resolve it.
    var reloadHeapMesh: { defineContract: typeof defineContract; defineCrud: typeof defineCrud; defaultPrint: typeof defaultPrint; z: typeof z } | undefined;
}

const loadContract = defineContract({
    domain: 'reloadheap', action: 'load', description: 'test: load a built part on this node',
    inputSchema: z.object({ modulePath: z.string() }), outputSchema: z.object({ domain: z.string() }),
    rest: { method: 'POST', path: '/reloadheap/load' }, filePath: 'test/partReloadHeap.integration.test.ts',
    concurrency: 'on-demand', permissions: [], print: defaultPrint,
});
const unloadContract = defineContract({
    domain: 'reloadheap', action: 'unload', description: 'test: unload a built part from this node',
    inputSchema: z.object({ modulePath: z.string() }), outputSchema: z.object({ contracts: z.number() }),
    rest: { method: 'POST', path: '/reloadheap/unload' }, filePath: 'test/partReloadHeap.integration.test.ts',
    concurrency: 'on-demand', permissions: [], print: defaultPrint,
});

/** How each case hooks into the broker; every one closes over the build's ballast. */
const CASES: Readonly<Record<string, string>> = {
    'nothing (register only)': `
        return 'reloadheapbare';`,
    'a contract': `
        const c = defineContract({ domain: 'reloadheapcontract', action: 'size', description: 'test',
            inputSchema: z.object({}), outputSchema: z.object({ n: z.number() }),
            rest: { method: 'GET', path: '/reloadheapcontract/size' }, filePath: 'test', concurrency: 'on-demand', permissions: [], print: defaultPrint });
        broker.registerContract(c, async () => ({ n: ballast.length }));
        return 'reloadheapcontract';`,
    'an event handler': `
        broker.registerEventHandler('reloadheap.ping', function () { globalThis.reloadHeapSeen = ballast.length; });
        return 'reloadheapevent';`,
    'an interval contract': `
        const c = defineContract({ domain: 'reloadheaptick', action: 'tick', description: 'test',
            inputSchema: z.object({}), outputSchema: z.object({}),
            rest: { method: 'POST', path: '/reloadheaptick/tick' }, filePath: 'test', concurrency: 'interval', intervalMs: 60000, permissions: [], print: defaultPrint });
        broker.registerContract(c, async () => { globalThis.reloadHeapSeen = ballast.length; return {}; });
        return 'reloadheaptick';`,
    'a CRUD collection and its hook': `
        const crud = defineCrud('reloadheapNote', z.object({ tenantId: z.string(), name: z.string() }), {
            pluralPath: 'reloadheapNotes', scopedBy: 'tenantId', dependencies: [], filePath: 'test', permissions: [] });
        broker.registerCrud(crud);
        broker.registerCrudHook('reloadheapNote', 'create', { before: async (input) => { globalThis.reloadHeapSeen = ballast.length; return input; } });
        return 'reloadheapNote';`,
};

let built = 0;

/** A fresh build of one case: its own file, as each deploy's artifact is. */
function writeBuild(dir: string, body: string): string {
    built += 1;
    const file = path.join(dir, `build-${built}.cjs`);
    fs.writeFileSync(file, `
// ${BALLAST_MB} MB of this build's own, on the heap: numbers, not a Buffer (which is off it).
const ballast = new Array(${BALLAST_MB * 131072}).fill(0).map((_, i) => i + ${built} * 0.5);
exports.register = function register(broker) {
    const { defineContract, defineCrud, defaultPrint, z } = globalThis.reloadHeapMesh;
    ${body}
};
`);
    return file;
}

/** The heap in MB once everything collectable is collected. */
async function heapAfterGc(): Promise<number> {
    v8.setFlagsFromString('--expose-gc');
    const gc: unknown = vm.runInNewContext('gc');
    for (let i = 0; i < 3; i++) {
        if (typeof gc === 'function') gc();
        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    return process.memoryUsage().heapUsed / 1048576;
}

describe('a reloaded part gives back its old build\'s memory (11-06, core\'s heap)', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let dir: string;
    const kept: Record<string, number> = {};

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'part-reload-heap-'));
        globalThis.reloadHeapMesh = { defineContract, defineCrud, defaultPrint, z };

        app = new MeshApp({ nodeID: 'reload-heap-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 16579, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

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
        console.log(`kept after ${RELOADS} reloads of a ${BALLAST_MB} MB part:\n${Object.entries(kept).map(([name, mb]) => `  ${name}: ${mb.toFixed(1)} MB`).join('\n')}`);
        await app.stop();
        fs.rmSync(dir, { recursive: true, force: true });
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it(`the control: a part that keeps its ballast on a global is seen keeping every build`, async () => {
        const before = await heapAfterGc();

        for (let i = 0; i < RELOADS; i++) {
            const build = writeBuild(dir, `
                globalThis.reloadHeapKept = (globalThis.reloadHeapKept || []).concat([ballast]);
                return 'reloadheapleak';`);
            await broker.call('reloadheap.load', { modulePath: build });
            await broker.call('reloadheap.unload', { modulePath: build });
        }

        kept['the control (leaks on purpose)'] = (await heapAfterGc()) - before;
        Reflect.deleteProperty(globalThis, 'reloadHeapKept');

        // Every build kept: the measure sees a leak when there is one.
        expect(kept['the control (leaks on purpose)']).toBeGreaterThan(BALLAST_MB * RELOADS * 0.8);
    }, 120000);

    for (const [name, body] of Object.entries(CASES)) {
        it(`${name}: ${RELOADS} reloads keep less than one build`, async () => {
            const before = await heapAfterGc();

            for (let i = 0; i < RELOADS; i++) {
                const build = writeBuild(dir, body);
                await broker.call('reloadheap.load', { modulePath: build });
                await broker.call('reloadheap.unload', { modulePath: build });
            }

            kept[name] = (await heapAfterGc()) - before;

            // Given back: under one build's ballast kept, after eight of them.
            expect(kept[name]).toBeLessThan(BALLAST_MB);
        }, 120000);
    }
});
