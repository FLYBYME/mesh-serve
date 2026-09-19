import { z } from 'zod';

/**
 * A generic job: dispatch `contract` with `payload`, under `requestedBy`'s own identity, at most
 * `maxAttempts` times. Not scoped to any one consumer -- catalog.service.ts's watchRelease (a
 * 60s sweep, one build at a time, no lease, a crash leaves a row stuck at 'running' forever) and
 * mesh-infer's provider-slot acquisition both want the same claim/lease/retry primitive; this is
 * that primitive, not a builder-specific or infer-specific thing.
 */
export const queueSchema = z.object({
    tenantId: z.string().describe('The organization this job belongs to'),
    contract: z.string().describe('The domain.action to dispatch'),
    payload: z.record(z.string(), z.unknown()).describe('Input for that contract'),
    /**
     * Optional: absent means this is a system job, dispatched with bare {tenant_id} meta and no
     * caller -- catalog.service.ts's build dispatch is exactly this, a background sweep with no
     * originating human/agent to replay as. When present, dispatch replays under that account
     * (mesh-infer's tool calls, most concretely), not the queue service's own identity.
     */
    requestedBy: z.object({
        userId: z.string().describe('Dispatch replays under this account, not the queue service\'s own identity'),
    }).optional(),
    /**
     * Optional mutual-exclusion lane: at most one job in the same group is ever 'processing' at
     * once, cluster-wide, even though different groups all run fully concurrently up to
     * maxConcurrency. Absent means unlocked/ungrouped -- claims exactly as before, no behavior
     * change for an existing caller that never sets this (mesh-infer's provider-slot acquisition,
     * most concretely). Added for catalog builds: two parts built from the *same* repo share one
     * on-disk checkout directory (build.ts's ensureRepoCheckout), so running them concurrently
     * would have two `git checkout`/`reset --hard` calls stomping the same directory -- group:
     * repo.id keeps same-repo builds serialized while different repos build in parallel.
     */
    group: z.string().optional().describe('At most one job per group runs at a time, cluster-wide'),
    priority: z.number().default(0).describe('Higher claims first'),
    status: z.enum(['pending', 'processing', 'completed', 'failed']).default('pending'),
    attempts: z.number().default(0),
    maxAttempts: z.number().default(3),
    /**
     * Both the real ctx.call timeout AND the basis for the claim lease -- QueueService.LEASE_SLACK_MS
     * is added on top so a job's lease always outlives its own call, unlike the predecessor's
     * hardcoded 30s lease regardless of the job's declared timeout (a job running longer than 30s
     * got reclaimed and re-dispatched while its first attempt was still legitimately in flight).
     */
    timeoutMs: z.number().default(30_000),
    /**
     * `z.coerce.date()`, not `z.string()` -- matching createdAt/updatedAt, not an accident. mesh's
     * JSONSerializer revives any full-ISO-instant *string* crossing a network hop into a real
     * `Date` (documented in JSONSerializer.ts: a rolling-upgrade-safe trade-off, not a bug), so a
     * `z.string()` field storing one fails its own schema the moment a call carrying it crosses a
     * real node boundary -- serve.queue.claim being leaderScoped means every claim from a
     * non-leader node does exactly that. `z.coerce.date()` accepts a string OR a Date, so it's
     * correct whichever one arrives, and matches the one pattern in this codebase already proven
     * to survive a remote call (see mesh's own RemoteDateCall.spec.ts).
     */
    lockedUntil: z.coerce.date().optional().describe('A processing row past this is treated as abandoned and reclaimed'),
    /** Backoff: a failed row isn't eligible for reclaim again until this passes -- unset means
     *  eligible immediately (used only for the first attempt, never after a failure). */
    nextAttemptAt: z.coerce.date().optional(),
    error: z.string().optional(),
}).describe('One dispatch of a contract call, claimed and leased rather than run inline');
