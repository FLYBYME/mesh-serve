import { Database } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { queueCrud, type QueueClaimInput, type QueueClaimOutput } from '../contracts/queue.contract.js';
import type { QueueService } from '../queue.service.js';

/** How far past a job's own timeoutMs its lease extends -- long enough that a legitimately
 *  slow-but-still-running call is never reclaimed out from under itself. No "generous default,
 *  then correct" two-step needed anymore (the predecessor's real reason for that dance): the whole
 *  find-then-write here runs inside a single lock, so job.timeoutMs is already known before the
 *  one write that sets lockedUntil, not split across two separate operations racing each other. */
const LEASE_SLACK_MS = 5_000;

/**
 * `serve.queue.claim` declares `leaderScoped: true`, so this only ever runs on serve.queue's
 * leader node -- but that alone doesn't stop two overlapping calls that both reach that node (one
 * per tick, from however many nodes are in the cluster) from both finding the same eligible row
 * before either claims it. `withLock`, on a single fixed key (there's no per-row key to serialize
 * on ahead of time -- the whole point of this call is finding out *which* row), closes that: only
 * one claim runs at a time, cluster-wide.
 *
 * Because of that, this is a plain find then a plain write -- no MongoDB-specific conditional
 * update operator anywhere. The atomicity isn't "the database promises this row-level compare-and-
 * swap is safe," it's "only one process is ever inside this block at once." That's also why this
 * needed to be its own leaderScoped contract rather than staying a private method QueueService
 * called on itself: without the routing, every node would still be doing this find-then-write
 * independently, and withLock only serializes callers that actually reach the same process.
 *
 * This is deliberately the *only* leader-pinned step. Once a job is claimed, running it
 * (queue.service.ts's run()) is not locked or leader-scoped at all -- every node keeps running its
 * own claimed jobs fully in parallel. Claiming is cheap; only the "who gets to decide" moment needs
 * to be single-threaded, not the work itself.
 */
export async function claim(
    this: QueueService,
    _input: QueueClaimInput,
    ctx: IServiceContext,
): Promise<QueueClaimOutput> {
    return ctx.withLock('serve.queue:claim', async () => {
        const db = ctx.broker.getProvider<Database>('database');
        const repo = db.repo(queueCrud.get.outputSchema, 'serve.queue');
        const now = new Date();

        const candidates = await repo.find({
            query: {
                $or: [
                    { status: 'pending', nextAttemptAt: { $exists: false } },
                    { status: 'pending', nextAttemptAt: { $lte: now } },
                    { status: 'processing', lockedUntil: { $lt: now } },
                ],
            },
            sort: { priority: -1, createdAt: 1 },
            limit: 1,
        });

        const job = candidates[0];
        if (job === undefined) return undefined;

        // The schema declares real defaults (timeoutMs: 30_000, attempts: 0) that always apply at
        // parse time, so these are never actually undefined at runtime -- ZodDefault's own output
        // type just doesn't propagate as non-optional through DomainRepository's generic here.
        const timeoutMs = job.timeoutMs ?? 30_000;
        const attempts = job.attempts ?? 0;

        const lockedUntil = new Date(now.getTime() + timeoutMs + LEASE_SLACK_MS);
        return ctx.call('serve.queue.update', {
            id: job.id,
            status: 'processing',
            attempts: attempts + 1,
            lockedUntil,
        }, { meta: { tenant_id: job.tenantId } });
    });
}
