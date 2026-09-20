import { ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceToolRegistry } from '@flybyme/mesh';

import { queueCrud, queueClaimContract, type QueueJob } from './contracts/queue.contract.js';
import { claim } from './tools/claim.js';

/**
 * Generic job queue: claim (leader-pinned, lock-serialized, no database-specific atomicity
 * assumed), dispatch under the original caller's identity, retry with backoff. Built to replace
 * two separate half-versions of this that already existed -- catalog.service.ts's watchRelease
 * (60s sweep, one build at a time, no lease, a crash leaves a row at 'running' forever) and an
 * older standalone JobQueueService (single-job-per-tick, a plain by-id update with no precondition
 * claiming to be "atomic" when it wasn't, a 30s lease hardcoded regardless of the job's own
 * timeout). Neither consumer has been moved onto this yet -- that's a separate, deliberate
 * follow-up, not done here.
 *
 * Claiming (tools/claim.ts) is the only leader-pinned, lock-serialized step -- running a claimed
 * job (`run`, below) is neither of those things and never has been: every node keeps running its
 * own claimed jobs fully in parallel, on its own tick loop. Claiming is cheap and needs exactly one
 * process deciding at a time; running is the actual work, and that's exactly what should scale
 * across the cluster.
 */
export class QueueService extends ServiceModule {
    public readonly domain = 'serve.queue';

    private broker!: IServiceBroker;
    private timer: NodeJS.Timeout | undefined;
    private readonly inFlight = new Set<string>();

    constructor(private readonly maxConcurrency = 5, private readonly tickIntervalMs = 500) {
        super();

        this.mountCrud(queueCrud);
        this.mountTool(queueClaimContract, claim);
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
     * once. Claims fire sequentially within a tick (each is a fast dispatched call, not a direct
     * method call anymore -- see tools/claim.ts for why that distinction is what makes leaderScoped
     * apply to it at all), but the work they kick off runs concurrently: `run()` below is
     * deliberately not awaited here.
     */
    private async tick(): Promise<void> {
        while (this.inFlight.size < this.maxConcurrency) {
            const job = await this.broker.call('serve.queue.claim', {});
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

    private async run(job: QueueJob): Promise<void> {
        // A system job (no requestedBy -- catalog's build dispatch, most concretely) runs with
        // bare tenant scope and no caller, the same convention buildArtifact's own internal calls
        // already use. resolveCallerScope (DatabaseMiddleware) falls back to meta.tenant_id when
        // meta.user is absent, so this is not a degraded case, just the correct one for a job
        // nothing signed in ever asked for.
        const meta = job.requestedBy !== undefined
            ? { user: { id: job.requestedBy.userId, tenant_id: job.tenantId } }
            : { tenant_id: job.tenantId };
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
                nextAttemptAt: new Date(Date.now() + backoffMs),
            }, { meta: { tenant_id: job.tenantId } });
            this.broker.logger.debug(`serve.queue: ${job.id} failed, retrying in ${backoffMs}ms`);
        }
    }
}

// See identity.service.ts's own comment on this -- required to be loadable as a dynamically-
// loaded part.
export default QueueService;
