import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { queueSchema } from '../schema/queue.js';

/**
 * `update`/`delete` stay internal (the default): only QueueService's own consumer loop moves a
 * row between statuses, and `serve.queue.claim` (below) is the only thing that ever moves one out
 * of 'pending' -- `update` has no way to express "only if still pending", so it's not the right
 * tool for claiming, only for completing/failing a job something already holds.
 */
export const queueCrud = defineCrud('serve.queue', queueSchema, {
    pluralPath: 'queue',
    scopedBy: 'tenantId',
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: [],
    filePath: 'src/queue/contracts/queue.contract.ts',
    permissions: [],
});

export type QueueJob = z.infer<typeof queueCrud.outputSchema>;

export const queueClaimInputSchema = z.object({});
export const queueClaimOutputSchema = queueCrud.get.outputSchema.optional();

/**
 * Not tenant-scoped -- there is no single caller here, QueueService's own tick loop calls this
 * with no meta.tenant_id, the same reasoning catalog.service.ts's watchRelease has always used for
 * its own cross-tenant sweep. `leaderScoped: true` is the actual point of this being a real
 * contract rather than a private method: QueueService.tick() dispatches through it instead of
 * calling a local method directly, so every node's own tick naturally funnels onto whichever one
 * is currently serve.queue's leader -- the atomicity for "only one node claims a given row" comes
 * from that plus withLock (queue.service.ts's claim.ts), not from a database-specific conditional
 * write. A plain find, then a plain write, both perfectly ordinary operations any storage backend
 * supports -- nothing here depends on MongoDB specifically providing findOneAndUpdate.
 */
export const queueClaimContract = defineContract({
    domain: 'serve.queue',
    action: 'claim',
    description: 'Claim one eligible job across every tenant, or return undefined if none is available right now.',
    inputSchema: queueClaimInputSchema,
    outputSchema: queueClaimOutputSchema,
    rest: { method: 'POST', path: '/queue/claim' },
    destructive: true,
    leaderScoped: true,
    dependencies: ['serve.queue'],
    filePath: 'src/queue/tools/claim.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o === undefined ? 'nothing to claim' : `claimed ${o.id} (${o.contract})`),
});

export type QueueClaimInput = z.infer<typeof queueClaimContract.inputSchema>;
export type QueueClaimOutput = z.infer<typeof queueClaimContract.outputSchema>;

/** How many jobs one node runs at a time. Per node, not per cluster -- see the tick handler. */
export const QUEUE_MAX_CONCURRENCY = Number(process.env.QUEUE_MAX_CONCURRENCY ?? 5);

/**
 * The tick loop, as a contract rather than a `setInterval` inside a class.
 *
 * Deliberately *not* `leaderScoped`, unlike `claim` above: every node ticks, and every node runs
 * the jobs it claims. Only claiming is a singleton, and `claim` already enforces that itself. If
 * this were leaderScoped the whole queue would collapse onto one node -- which is the thing the
 * split between these two contracts exists to prevent.
 */
export const queueTickContract = defineContract({
    domain: 'serve.queue',
    action: 'tick',
    description: 'Top this node up to its concurrency limit by claiming and running eligible jobs.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        started: z.number().describe('Jobs claimed and started on this node by this tick'),
        inFlight: z.number().describe('Jobs running on this node after this tick'),
    }),
    // Internal by default, like every contract that doesn't say otherwise -- but it is a perfectly
    // ordinary contract, so a manual "tick now" call is available to an operator without the timer
    // having to be involved at all.
    rest: { method: 'POST', path: '/queue/tick' },
    destructive: true,
    dependencies: ['serve.queue'],
    filePath: 'src/queue/tools/tick.ts',
    concurrency: 'interval',
    intervalMs: Number(process.env.QUEUE_TICK_MS ?? 500),
    permissions: [],
    print: (o) => `started ${o.started}, ${o.inFlight} in flight`,
});

export type QueueTickOutput = z.infer<typeof queueTickContract.outputSchema>;
