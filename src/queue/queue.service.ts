import { Database, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceToolRegistry } from '@flybyme/mesh';

import { queueCrud, type QueueJob } from './contracts/queue.contract.js';

/**
 * Generic job queue: claim (atomic, lease-based), dispatch under the original caller's identity,
 * retry with backoff, reclaim an abandoned lease. Built to replace two separate half-versions of
 * this that already existed -- catalog.service.ts's watchRelease (60s sweep, one build at a time,
 * no lease, a crash leaves a row at 'running' forever) and an older standalone JobQueueService
 * (single-job-per-tick, a plain by-id update with no precondition claiming to be "atomic" when it
 * wasn't, a 30s lease hardcoded regardless of the job's own timeout). Neither consumer has been
 * moved onto this yet -- that's a separate, deliberate follow-up, not done here.
 */
export class QueueService extends ServiceModule {
    public readonly domain = 'serve.queue';

    /** How far past a job's own timeoutMs its lease extends -- long enough that a legitimately
     *  slow-but-still-running call is never reclaimed out from under itself. */
    private static readonly LEASE_SLACK_MS = 5_000;

    /**
     * The claim step's own initial lease, before the job's real timeoutMs is known (see claim()).
     * Deliberately generous: this only has to survive the instant between the claiming
     * findOneAndUpdate and the immediately-following correction to the job's real lease, not
     * protect the job for its whole run. A job whose own timeoutMs exceeds this is still safe --
     * the correction below sets the real, longer lease before this default one could ever expire.
     */
    private static readonly CLAIM_DEFAULT_LEASE_MS = 5 * 60_000;

    private broker!: IServiceBroker;
    private timer: NodeJS.Timeout | undefined;
    private readonly inFlight = new Set<string>();

    constructor(private readonly maxConcurrency = 5, private readonly tickIntervalMs = 500) {
        super();

        this.mountCrud(queueCrud);
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        this.timer = setInterval(() => {
            this.tick().catch((err) => {
                this.broker.logger.error('serve.queue tick failed', err);
            });
        }, this.tickIntervalMs);
    }

    public async onStop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
    }

    /**
     * Tops up in-flight work to maxConcurrency, rather than leasing one job per tick -- the
     * predecessor's real bug wasn't the tick rate, it was that only one job was ever running at
     * once. Claims fire sequentially within a tick (each is a fast single findOneAndUpdate), but
     * the work they kick off runs concurrently: `run()` below is deliberately not awaited here.
     */
    private async tick(): Promise<void> {
        while (this.inFlight.size < this.maxConcurrency) {
            const job = await this.claim();
            if (job === undefined) return;

            this.inFlight.add(job.id);
            this.run(job)
                .catch((err) => {
                    this.broker.logger.error(`serve.queue job ${job.id} threw outside its own handling`, err);
                })
                .finally(() => {
                    this.inFlight.delete(job.id);
                });
        }
    }

    /**
     * The one atomic step. `serve.queue.update` (the generated crud action) takes an id and no
     * other precondition, so it cannot express "only if still pending" -- that's exactly what a
     * job-queue claim needs, and exactly what the predecessor's find-then-update pair didn't
     * actually provide (two workers can both find_one the same row before either updates it). A
     * raw findOneAndUpdate against the real collection is a single round trip to Mongo with the
     * precondition baked into the filter, which is what makes this safe under real concurrency --
     * multiple QueueService instances, not just multiple in-process claims.
     */
    private async claim(): Promise<QueueJob | undefined> {
        const db = this.broker.getProvider<Database>('database');
        const repo = db.repo(queueCrud.get.outputSchema, 'serve.queue');

        const now = new Date();
        const nowIso = now.toISOString();

        const doc = await repo.rawCollection.findOneAndUpdate(
            {
                $or: [
                    { status: 'pending', $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: nowIso } }] },
                    { status: 'processing', lockedUntil: { $lt: nowIso } },
                ],
            },
            {
                $set: {
                    status: 'processing',
                    lockedUntil: new Date(now.getTime() + QueueService.CLAIM_DEFAULT_LEASE_MS).toISOString(),
                },
                $inc: { attempts: 1 },
            },
            { sort: { priority: -1, createdAt: 1 }, returnDocument: 'after' },
        );
        if (doc === null) return undefined;

        const job = queueCrud.get.outputSchema.parse({ ...doc, id: String(doc._id ?? doc.id) });

        // Correct the generous default lease above to the job's own real timeoutMs, now that it's
        // known. Safe as a separate, unconditional-by-id update: this worker already owns the row
        // (nothing else can match it -- status is 'processing' and the default lease hasn't
        // lapsed), so there's nothing to race against.
        const lockedUntil = new Date(now.getTime() + job.timeoutMs + QueueService.LEASE_SLACK_MS).toISOString();
        await this.broker.call('serve.queue.update', { id: job.id, lockedUntil }, { meta: { tenant_id: job.tenantId } });

        return { ...job, lockedUntil };
    }

    private async run(job: QueueJob): Promise<void> {
        const meta = { user: { id: job.requestedBy.userId, tenant_id: job.tenantId } };
        this.broker.logger.debug(`serve.queue: running ${job.id} (${job.contract}), attempt ${job.attempts}/${job.maxAttempts}`);

        try {
            await this.broker.call(
                job.contract as keyof IServiceToolRegistry,
                job.payload as never,
                { meta, timeout: job.timeoutMs },
            );
            await this.broker.call('serve.queue.update', { id: job.id, status: 'completed' }, { meta: { tenant_id: job.tenantId } });
            this.broker.logger.debug(`serve.queue: completed ${job.id}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job.attempts >= job.maxAttempts) {
                await this.broker.call('serve.queue.update', {
                    id: job.id, status: 'failed', error: message,
                }, { meta: { tenant_id: job.tenantId } });
                this.broker.logger.error(`serve.queue: ${job.id} failed permanently after ${job.attempts} attempts`, err);
                return;
            }

            // Exponential-ish backoff, capped at a minute -- the predecessor retried a failed job
            // on its very next 1-second tick, forever, which is a tight loop against whatever just
            // failed (a down provider, most concretely) rather than a retry policy.
            const backoffMs = Math.min(1000 * job.attempts ** 2, 60_000);
            await this.broker.call('serve.queue.update', {
                id: job.id, status: 'pending', error: message,
                nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
            }, { meta: { tenant_id: job.tenantId } });
            this.broker.logger.debug(`serve.queue: ${job.id} failed, retrying in ${backoffMs}ms`);
        }
    }
}
