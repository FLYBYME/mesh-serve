import { defineCrud, z } from '@flybyme/mesh';

import { repoSchema } from '../schema/repo.js';

export const repoCrud = defineCrud('serve.repo', repoSchema, {
    pluralPath: 'repos',
    scopedBy: 'tenantId',
    unique: [{ fields: 'url', scope: 'scoped' }],
    visibility: {},
    dependencies: [],
});

export type Repo = z.infer<typeof repoCrud.outputSchema>;
