import { defineCrud, z } from '@flybyme/mesh';

import { organizationSchema } from '../schema/organization.js';

export const organizationCrud = defineCrud('identity.organization', organizationSchema, {
    pluralPath: 'organizations',
    unique: [{ fields: 'slug', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: ['identity.user'],
});

export type Organization = z.infer<typeof organizationCrud.outputSchema>;
