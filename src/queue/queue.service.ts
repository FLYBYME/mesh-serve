import type { IServiceBroker } from '@flybyme/mesh';

import { queueCrud, queueClaimContract, queueTickContract } from './contracts/queue.contract.js';
import { claim } from './tools/claim.js';
import { tick } from './tools/tick.js';

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
 * job (tools/tick.ts) is neither of those things and never has been: every node keeps running its
 * own claimed jobs fully in parallel, on its own tick. Claiming is cheap and needs exactly one
 * process deciding at a time; running is the actual work, and that's exactly what should scale
 * across the cluster.
 *
 * No `ServiceModule`, no class. The tick loop used to be a `timer` field, a `setInterval` in
 * `onStart` and a `clearInterval` in `onStop`; it is now `queueTickContract`'s declared
 * `concurrency: 'interval'` + `intervalMs`, with the broker owning the timer (and the
 * no-overlapping-ticks guarantee that class had to hand-roll). Nothing is left for a lifecycle
 * object to hold, so this part returns a bare domain string rather than a `stop`.
 */
export const QUEUE_DOMAIN = 'serve.queue';

export function register(broker: IServiceBroker): string {
    broker.registerCrud(queueCrud);
    broker.registerContract(queueClaimContract, claim);
    broker.registerContract(queueTickContract, tick);
    return QUEUE_DOMAIN;
}
