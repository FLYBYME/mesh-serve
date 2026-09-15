import { defineCrud, z } from '@flybyme/mesh';

import { partSchema } from '../schema/part.js';

export const partCrud = defineCrud('serve.part', partSchema, {
    pluralPath: 'parts',
    scopedBy: 'tenantId',
    // key is namespaced "org-slug/part-name" (enforced in catalog.service.ts's create/update hooks),
    // so it's already globally disambiguated -- global uniqueness matches that, not tenant-scoped.
    unique: [{ fields: 'key', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: ['serve.repo'],
});

export type Part = z.infer<typeof partCrud.outputSchema>;
