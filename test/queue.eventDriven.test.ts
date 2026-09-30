/**
 * The queue runs a job because it was created, not because a timer came round (2026-09-30).
 *
 * The tick ran every 500 ms on every queue node, each pass a `claim` funnelled onto the leader --
 * 2 claims a second with nothing queued. The timer is now a 60 s safety net; here it is set to 10
 * minutes, so a job that runs within seconds can only have been started by its own
 * `serve.queue.created`, and a retry only by its own backoff wake-up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, Logger, LogLevel, MeshApp, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

vi.hoisted(() => {
    process.env.QUEUE_TICK_MS = '600000';
});

import '../src/queue/contracts/queue.contract.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';

const DB_NAME = 'mesh-serve-queue-event-test';
const TENANT_ID = 'test-tenant';
const meta = { tenant_id: TENANT_ID };

describe('serve.queue, event-driven', () => {
    let app: MeshApp;

    beforeAll(async () => {
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        await mongo.db(DB_NAME).dropDatabase();
        await mongo.close();

        app = new MeshApp({ nodeID: 'queue-event-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new DatabaseModule({ dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        await app.getProvider<IServiceBroker>('broker').loadDomain('serve.queue', {}, { resolve: resolveHandler });
        // The interval's first pass, which is what starts the listening.
        await new Promise((r) => setTimeout(r, 300));
    });

    afterAll(async () => {
        await app?.stop();
    });

    async function statusOf(id: string): Promise<string | undefined> {
        const rows = await app.call('serve.queue.find', { query: { id } }, { meta });
        return rows[0]?.status;
    }

    it('runs a job within seconds of its creation, with the timer ten minutes away', async () => {
        const job = await app.call('serve.queue.create', {
            tenantId: TENANT_ID,
            contract: 'serve.queue.find_one',
            payload: { query: { id: 'marker' } },
            maxAttempts: 1,
            timeoutMs: 5000,
        }, { meta });

        await vi.waitFor(async () => expect(await statusOf(job.id)).toBe('completed'), { timeout: 5000, interval: 100 });
    });

    it('retries a failed job when its backoff comes due, not on a timer', async () => {
        const job = await app.call('serve.queue.create', {
            tenantId: TENANT_ID,
            contract: 'serve.queue.no_such_action',
            payload: {},
            maxAttempts: 2,
            timeoutMs: 2000,
        }, { meta });

        // First attempt fails, backoff 1 s, second attempt fails for good.
        await vi.waitFor(async () => expect(await statusOf(job.id)).toBe('failed'), { timeout: 8000, interval: 100 });
        const [row] = await app.call('serve.queue.find', { query: { id: job.id } }, { meta });
        expect(row?.attempts).toBe(2);
    }, 12_000);
});
