import { defineCrud, z } from '@flybyme/mesh';

import { wantSchema } from '../schema/want.js';

export const wantCrud = defineCrud('serve.want', wantSchema, {
    pluralPath: 'wants',
    scopedBy: 'tenantId',
    unique: [{ fields: ['siteId', 'contract'], scope: 'scoped' }],
    visibility: {},
    dependencies: ['serve.site'],
});

export type Want = z.infer<typeof wantCrud.outputSchema>;
