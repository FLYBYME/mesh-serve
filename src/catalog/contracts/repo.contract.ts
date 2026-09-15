import { defineCrud, z } from '@flybyme/mesh';

import { repoSchema } from '../schema/repo.js';

export const repoCrud = defineCrud('serve.repo', repoSchema, {
    pluralPath: 'repos',
    scopedBy: 'tenantId',
    unique: [{ fields: 'url', scope: 'scoped' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: [],
});

export type Repo = z.infer<typeof repoCrud.outputSchema>;
