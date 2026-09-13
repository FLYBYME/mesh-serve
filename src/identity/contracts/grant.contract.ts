import { defineCrud, z } from '@flybyme/mesh';

import { grantSchema } from '../schema/grant.js';

export const grantCrud = defineCrud('identity.grant', grantSchema, {
    pluralPath: 'grants',
    unique: [{ fields: ['roleKey', 'contract'], scope: 'global' }],
    visibility: {
        find: 'public', create: 'public', delete: 'public',
    },
    dependencies: ['identity.role'],
});

export type Grant = z.infer<typeof grantCrud.outputSchema>;
