import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { exposeSchema } from '../schema/expose.js';

export const exposeCrud = defineCrud('serve.expose', exposeSchema, {
    pluralPath: 'exposures',
    scopedBy: 'tenantId',
    unique: [{ fields: ['siteId', 'contract'], scope: 'scoped' }],
    visibility: { find: 'public', get: 'public', count: 'public', delete: 'public' },
    dependencies: [],
});

export type Expose = z.infer<typeof exposeCrud.outputSchema>;

export const exposeAddContract = defineContract({
    domain: 'serve.expose',
    action: 'add',
    description: 'Expose one contract on a site, at exactly one gate.',
    inputSchema: z.object({
        siteId: z.string().min(1),
        contract: z.string().min(1),
        errors: z.array(z.string()).optional(),
    }).and(z.union([
        z.object({ auth: z.enum(['public', 'authenticated']) }),
        z.object({ permission: z.string().min(1) }),
    ])),
    outputSchema: exposeCrud.get.outputSchema,
    rest: { method: 'POST', path: '/sites/:siteId/expose' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.contract} exposed`,
});
