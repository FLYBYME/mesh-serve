import { defineCrud, z } from '@flybyme/mesh';

import { membershipSchema } from '../schema/membership.js';

export const membershipCrud = defineCrud('identity.membership', membershipSchema, {
    pluralPath: 'memberships',
    scopedBy: 'userId',
    unique: [{ fields: 'organizationId', scope: 'scoped' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
        create: 'public', delete: 'public',
    },
    dependencies: ['identity.organization', 'identity.user'],
});

export type Membership = z.infer<typeof membershipCrud.outputSchema>;
