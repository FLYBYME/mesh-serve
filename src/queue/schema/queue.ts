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
    requestedBy: z.object({
        userId: z.string().describe('Dispatch replays under this account, not the queue service\'s own identity'),
    }),
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
    lockedUntil: z.string().optional().describe('ISO timestamp; a processing row past this is treated as abandoned and reclaimed'),
    /** Backoff: a failed row isn't eligible for reclaim again until this passes -- unset means
     *  eligible immediately (used only for the first attempt, never after a failure). */
    nextAttemptAt: z.string().optional().describe('ISO timestamp'),
    error: z.string().optional(),
}).describe('One dispatch of a contract call, claimed and leased rather than run inline');
