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
    print: (o) => (o === undefined ? 'nothing to claim' : `claimed ${o.id} (${o.contract})`),
});

export type QueueClaimInput = z.infer<typeof queueClaimContract.inputSchema>;
export type QueueClaimOutput = z.infer<typeof queueClaimContract.outputSchema>;
