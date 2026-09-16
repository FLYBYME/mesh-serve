import { defineCrud, z } from '@flybyme/mesh';

import { queueSchema } from '../schema/queue.js';

/**
 * `update`/`delete` stay internal (the default): only QueueService's own consumer loop moves a row
 * between statuses, and it does the claim step itself via a raw atomic findOneAndUpdate rather than
 * this crud's own `update` action -- `update` has no way to express "only if still pending", so it
 * is not the right tool for claiming a job, only for completing/failing one QueueService already
 * holds the lease on.
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
