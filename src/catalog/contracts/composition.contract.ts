import { defineCrud, z } from '@flybyme/mesh';

import { compositionSchema } from '../schema/composition.js';

export const compositionCrud = defineCrud('serve.composition', compositionSchema, {
    pluralPath: 'compositions',
    scopedBy: 'tenantId',
    unique: [{ fields: 'key', scope: 'scoped' }],
    visibility: {},
    dependencies: ['serve.part'],
});

export type Composition = z.infer<typeof compositionCrud.outputSchema>;
