/**
 * The point of moving claim() behind serve.queue.claim (leaderScoped) + withLock was to prove a
 * job never gets claimed twice when more than one physical node is running QueueService -- a
 * single-process test can only prove the function doesn't throw, not that the guarantee survives
 * real network+DB latency. Two real, separately networked MeshApp instances, same pattern as
 * mesh-infer's provider.distributed.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { QueueService } from '../src/queue/queue.service.js';

const DB_NAME = 'mesh-serve-queue-distributed-test';
const TENANT_ID = 'test-tenant';

describe('serve.queue.claim across two real nodes', () => {
    let appA: MeshApp;
    let appB: MeshApp;

    beforeAll(async () => {
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        await mongo.db(DB_NAME).dropDatabase();
        await mongo.close();

        const logger = new Logger(LogLevel.ERROR);
        const serializer = new JSONSerializer();

        appA = new MeshApp({ nodeID: 'queue-dist-node-a', logger });
        appA.use(new RegistryModule());
        appA.use(new NetworkModule({
            port: 6541,
            transports: [new WSTransport(serializer, 6541, '127.0.0.1')],
        }));
        appA.use(new DatabaseModule({ dbName: DB_NAME }));
        appA.use(new BrokerModule());
        await appA.start();
        // maxConcurrency: 1 -- isolates the claim-safety property from run()'s own concurrency, so
        // a test failure here can only mean claim() itself double-claimed, nothing else.
        await appA.registerModule(new QueueService(1, 50));

        appB = new MeshApp({ nodeID: 'queue-dist-node-b', logger });
        appB.use(new RegistryModule());
        appB.use(new NetworkModule({
            port: 6542,
            transports: [new WSTransport(serializer, 6542, '127.0.0.1')],
            bootstrapNodes: ['ws://127.0.0.1:6541'],
        }));
        appB.use(new DatabaseModule({ dbName: DB_NAME }));
        appB.use(new BrokerModule());
        await appB.start();
        await appB.registerModule(new QueueService(1, 50));

        await new Promise((r) => setTimeout(r, 800));
    });

    afterAll(async () => {
        await appB?.stop();
        await appA?.stop();
    });

    it('both nodes agree on the leader for serve.queue', () => {
        const registryA = appA.getProvider<{ leaderFor: (d: string) => { nodeID: string } | undefined }>('registry');
        const registryB = appB.getProvider<{ leaderFor: (d: string) => { nodeID: string } | undefined }>('registry');
        const leaderA = registryA.leaderFor('serve.queue');
        const leaderB = registryB.leaderFor('serve.queue');
        expect(leaderA).toBeDefined();
        expect(leaderA!.nodeID).toBe(leaderB!.nodeID);
    });

    it('20 real jobs, claimed concurrently from both nodes, each run exactly once', async () => {
        const meta = { tenant_id: TENANT_ID };

        // Any real contract works as the dispatch target -- serve.queue.find_one is cheap and
        // harmless, and its own result doesn't matter here; what matters is how many times each
        // row's own `attempts` counter ends up at.
        for (let i = 0; i < 20; i++) {
            await appA.call('serve.queue.create', {
                tenantId: TENANT_ID,
                contract: 'serve.queue.find_one',
                payload: { query: { id: `marker-${i}` } },
                requestedBy: { userId: 'system-test' },
                maxAttempts: 1,
                timeoutMs: 5000,
            }, { meta });
        }

        // Both nodes' tick loops are already running (registered in beforeAll) -- just wait for
        // every job to leave 'pending'/'processing'.
        const deadline = Date.now() + 15_000;
        let allDone = false;
        while (Date.now() < deadline && !allDone) {
            const rows = await appA.call('serve.queue.find', { query: { tenantId: TENANT_ID } }, { meta });
            allDone = rows.every((r) => r.status === 'completed' || r.status === 'failed');
            if (!allDone) await new Promise((r) => setTimeout(r, 100));
        }
        expect(allDone).toBe(true);

        const final = await appA.call('serve.queue.find', { query: { tenantId: TENANT_ID } }, { meta });
        expect(final).toHaveLength(20);
        // The real proof: every attempts count is exactly 1 -- if the same row were ever claimed
        // by both nodes, at least one job would show 2 (both claimers incrementing attempts on
        // what they each believed was their own exclusive claim).
        for (const row of final) {
            expect(row.attempts).toBe(1);
            expect(row.status).toBe('completed');
        }
    }, 20_000);
});
