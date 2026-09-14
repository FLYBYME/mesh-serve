import { defineCrud, z } from '@flybyme/mesh';

import { partSchema } from '../schema/part.js';

export const partCrud = defineCrud('serve.part', partSchema, {
    pluralPath: 'parts',
    scopedBy: 'tenantId',
    unique: [{ fields: 'key', scope: 'scoped' }],
    visibility: {},
    dependencies: ['serve.repo'],
});

export type Part = z.infer<typeof partCrud.outputSchema>;
