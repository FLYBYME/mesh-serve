import { defineCrud } from '@flybyme/mesh';

import { activitySchema } from '../schema/activity.js';

/**
 * The activity log (methods/activity.ts). Written by the api gateway alone; read by operators.
 * Global, not scoped: an operator's calls run in the api's own organization, and the log is
 * every organization's -- each row names the one it ran in. Rows expire after 90 days (a TTL index
 * the gateway ensures), so it can never fill the database the way stored builds did.
 */
export const activityCrud = defineCrud('serve.activity', activitySchema, {
    pluralPath: 'activity',
    delivery: 'global',
    dependencies: [],
    permissions: ['operator'],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    filePath: 'src/api/contracts/activity.contract.ts',
});
