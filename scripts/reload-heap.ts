/**
 * How much a part's reload keeps: loads and unloads one built part N times in one node, the way a
 * deploy does (loadAndRegisterModule / unloadAndEvictModule), and prints the heap after a forced GC
 * each round. A part that lets go comes back to where it started; one that leaks climbs each round.
 * Core grew ~40 MB a reload and crashed on the third (10-27 18:27Z).
 *
 *   node --expose-gc --import tsx scripts/reload-heap.ts <part.cjs> [rounds] [snapshot-dir]
 *
 * With a snapshot dir, a heap snapshot is written after the first and the last round, to compare.
 */
import { writeHeapSnapshot } from 'node:v8';
import path from 'node:path';
import {
    BrokerModule, DatabaseModule, defaultPrint, defineContract, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z, type IServiceBroker,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { loadAndRegisterModule, unloadAndEvictModule } from '../src/catalog/methods/loadModule.js';

const [part, roundsArg, snapshots] = process.argv.slice(2);
if (part === undefined) {
    console.error('usage: reload-heap.ts <part.cjs> [rounds] [snapshot-dir]');
    process.exit(2);
}
const rounds = Number(roundsArg ?? '6');

const loadContract = defineContract({
    domain: 'reloadheap', action: 'load', description: 'load the part', inputSchema: z.object({}), outputSchema: z.object({}),
    rest: { method: 'POST', path: '/reloadheap/load' }, filePath: 'scripts/reload-heap.ts', concurrency: 'on-demand', permissions: [], print: defaultPrint,
});
const unloadContract = defineContract({
    domain: 'reloadheap', action: 'unload', description: 'unload the part', inputSchema: z.object({}), outputSchema: z.object({}),
    rest: { method: 'POST', path: '/reloadheap/unload' }, filePath: 'scripts/reload-heap.ts', concurrency: 'on-demand', permissions: [], print: defaultPrint,
});

function heapMb(): number {
    globalThis.gc?.();
    globalThis.gc?.();

    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

const app = new MeshApp({ nodeID: 'reload-heap', logger: new Logger(LogLevel.ERROR) });
app.use(new RegistryModule({ implementation: PlacementRegistry }));
app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 16699, '127.0.0.1')] }));
app.use(new DatabaseModule({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017', dbName: 'reload-heap' }));
app.use(new BrokerModule());
await app.start();
const broker = app.getProvider<IServiceBroker>('broker');
const absolute = path.resolve(part);
broker.registerContract(loadContract, async (_input, ctx) => { await loadAndRegisterModule(ctx, absolute); return {}; });
broker.registerContract(unloadContract, async (_input, ctx) => { await unloadAndEvictModule(ctx, absolute); return {}; });

console.log(`before: ${heapMb()} MB`);
for (let i = 1; i <= rounds; i += 1) {
    await broker.call('reloadheap.load', {});
    await broker.call('reloadheap.unload', {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log(`after reload ${i}: ${heapMb()} MB`);
    if (snapshots !== undefined && (i === 1 || i === rounds)) console.log(`  snapshot ${writeHeapSnapshot(path.join(snapshots, `reload-${i}.heapsnapshot`))}`);
}

await app.stop();
process.exit(0);
