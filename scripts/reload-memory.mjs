/**
 * Where a node's memory goes across a part's reloads: the process's whole footprint, not only the JS
 * heap, with and without a forced collection. A live node is never forced, and reload-heap.ts always
 * forces one, so a part that looks flat there can still climb on a server. Runs the compiled build
 * with no tsx: tsx hooks every require, and its copies of a part's source count as memory here.
 *
 *   npm run build
 *   node --expose-gc scripts/reload-memory.mjs <part.cjs> [rounds] [settle-ms] [gc|nogc]
 *
 * The part must sit under this repository, for its require('@flybyme/mesh') to resolve.
 */
import { getHeapSpaceStatistics } from 'node:v8';
import path from 'node:path';
import {
    BrokerModule, DatabaseModule, defaultPrint, defineContract, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { loadAndRegisterModule, unloadAndEvictModule } from '../dist/catalog/methods/loadModule.js';

const [part, roundsArg, settleArg, modeArg] = process.argv.slice(2);
if (part === undefined) {
    console.error('usage: reload-memory.mjs <part.cjs> [rounds] [settle-ms] [gc|nogc]');
    process.exit(2);
}
const rounds = Number(roundsArg ?? '8');
const settleMs = Number(settleArg ?? '2000');
const forced = (modeArg ?? 'nogc') === 'gc';

const contract = (action) => defineContract({
    domain: 'reloadmemory',
    action,
    description: `${action} the part`,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    rest: { method: 'POST', path: `/reloadmemory/${action}` },
    filePath: 'scripts/reload-memory.mjs',
    concurrency: 'on-demand',
    permissions: [],
    print: defaultPrint,
});

const mb = (bytes) => Math.round(bytes / 1024 / 1024);

function sample(label) {
    const m = process.memoryUsage();
    const spaces = getHeapSpaceStatistics();
    const space = (name) => mb(spaces.find((s) => s.space_name === name)?.space_used_size ?? 0);

    console.log([
        label.padEnd(12),
        `rss ${mb(m.rss)}`,
        `heapTotal ${mb(m.heapTotal)}`,
        `heapUsed ${mb(m.heapUsed)}`,
        `code ${space('code_space')}`,
        `old ${space('old_space')}`,
        `external ${mb(m.external)}`,
        `buffers ${mb(m.arrayBuffers)}`,
        `rest ${mb(m.rss - m.heapTotal - m.external)}`,
    ].join('  '));
}

const app = new MeshApp({ nodeID: 'reload-memory', logger: new Logger(LogLevel.ERROR) });
app.use(new RegistryModule({ implementation: PlacementRegistry }));
app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 16698, '127.0.0.1')] }));
app.use(new DatabaseModule({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017', dbName: 'reload-memory' }));
app.use(new BrokerModule());
await app.start();

const broker = app.getProvider('broker');
const absolute = path.resolve(part);
broker.registerContract(contract('load'), async (_input, ctx) => {
    await loadAndRegisterModule(ctx, absolute);

    return {};
});
broker.registerContract(contract('unload'), async (_input, ctx) => {
    await unloadAndEvictModule(ctx, absolute);

    return {};
});

const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (forced) {
        globalThis.gc?.();
        globalThis.gc?.();
    }
};

await settle();
console.log(`mode: ${forced ? 'a forced collection before each reading' : 'no forced collection, as on a server'}`);
sample('before');

await broker.call('reloadmemory.load', {});
await settle();
sample('loaded');

for (let i = 1; i <= rounds; i += 1) {
    await broker.call('reloadmemory.unload', {});
    sample(`unloaded ${i}`);
    await broker.call('reloadmemory.load', {});
    await settle();
    sample(`reload ${i}`);
}

globalThis.gc?.();
globalThis.gc?.();
await new Promise((resolve) => setTimeout(resolve, 500));
sample('forced gc');

await broker.call('reloadmemory.unload', {});
await app.stop();
process.exit(0);
