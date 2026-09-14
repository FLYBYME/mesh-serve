import { defineCrud, z } from '@flybyme/mesh';

import { exposeSchema } from '../schema/expose.js';

export const exposeCrud = defineCrud('serve.expose', exposeSchema, {
    pluralPath: 'exposes',
    scopedBy: 'tenantId',
    unique: [{ fields: ['siteId', 'contract'], scope: 'scoped' }],
    visibility: {},
    dependencies: ['serve.site'],
});

export type Expose = z.infer<typeof exposeCrud.outputSchema>;
