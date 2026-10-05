import { Database } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { artifactCrud } from '../contracts/artifact.contract.js';
import type { WatchReleaseOutput } from '../contracts/artifact.contract.js';
import { queueCrud } from '../../queue/contracts/queue.contract.js';

/** Bound on both the real build's ctx.call timeout and serve.queue's own lease for it. */
// A part's first build installs its git dependencies cold, and a few of ours compile themselves on
// install: past 5 minutes, the call timed out while the build went on (2026-10-05).
export const BUILD_TIMEOUT_MS = 15 * 60_000;
/** The queue lane every build runs in: at most one at a time, cluster-wide. */
export const BUILD_QUEUE_GROUP = 'serve.artifact.build';

/**
 * Scans for pending artifacts across every tenant and enqueues a build for each.
 *
 * Cross-tenant on purpose: there is no single tenant this sweep runs as, so there is no
 * meta.tenant_id that could ever be correct. This is exactly the case `Database.repo()` exists for,
 * unlike every other call here (each of which resolves one artifact/part/repo that already names
 * its own tenant).
 *
 * Discovery only. It used to build every pending artifact inline, serially, one at a time with no
 * lease, so a crash mid-build left a row at 'running' forever with nothing to reclaim it. Now
 * serve.queue's claim loop does the dispatching, with real concurrency and a lease sized to
 * BUILD_TIMEOUT_MS. Flipping status to 'running' here -- rather than waiting for the queue to
 * actually claim the job -- is what stops the next sweep from finding the same still-queued
 * artifact and enqueuing it twice; waitForBuild (init.ts) already treats pending/running
 * identically, so nothing downstream had to tolerate anything new.
 *
 * maxAttempts: 1 -- a build failure is almost always deterministic (bad code, a missing
 * entrypoint), not transient. Retrying automatically wouldn't help and would delay surfacing a
 * real failure.
 *
 * The 60s timer belongs to the broker now (`concurrency: 'interval'`), not to a class field with a
 * matching clearInterval in an onStop.
 */
export async function watchRelease(_params: Record<string, never>, ctx: IServiceContext): Promise<WatchReleaseOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(artifactCrud.get.outputSchema, 'serve.artifact');
    const pending = await repo.find({ query: { status: 'pending' } });

    for (const raw of pending) {
        const artifact = artifactCrud.get.outputSchema.parse(raw);
        const meta = { tenant_id: artifact.tenantId };
        await ctx.call('serve.artifact.update', { id: artifact.id, status: 'running' }, { meta });
        await ctx.call('serve.queue.create', {
            tenantId: artifact.tenantId,
            contract: 'serve.artifact.build',
            payload: { id: artifact.id },
            timeoutMs: BUILD_TIMEOUT_MS,
            maxAttempts: 1,
            // One build at a time, cluster-wide. Ungrouped, a node ran up to QUEUE_MAX_CONCURRENCY (5)
            // builds at once: on 2026-09-27 eight parts were requested together, ns2 (3.8 GB) ran
            // their npm installs side by side, ran out of memory and had to be rebooted by hand.
            group: BUILD_QUEUE_GROUP,
        }, { meta });
    }

    // A build left 'running' after its job failed (its builder died, so nothing ran its own failure
    // path) is failed here, with the job's reason: a build never hangs at 'running'.
    const running = await repo.find({ query: { status: 'running' } });
    const failedJobs = running.length === 0
        ? []
        : await db.repo(queueCrud.get.outputSchema, 'serve.queue').find({ query: { contract: 'serve.artifact.build', status: 'failed' } });
    for (const raw of running) {
        const artifact = artifactCrud.get.outputSchema.parse(raw);
        const job = failedJobs.find((j) => j.payload.id === artifact.id);
        if (job === undefined) {
            continue;
        }

        await ctx.call('serve.artifact.update', {
            id: artifact.id, status: 'failed', error: job.error ?? 'Its build job failed.',
        }, { meta: { tenant_id: artifact.tenantId } });
        ctx.logger.error(`Build ${artifact.id} failed: ${job.error ?? 'its job failed'}`);
    }

    return { enqueued: pending.length };
}
