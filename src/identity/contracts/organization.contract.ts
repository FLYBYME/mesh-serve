import { defineCrud, MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { organizationSchema } from '../schema/organization.js';

export const organizationCrud = defineCrud('identity.organization', organizationSchema, {
    pluralPath: 'organizations',
    unique: [{ fields: 'slug', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    hooks: {
        create: {
            // An organization cannot be owned by an account that doesn't exist. Declared on the
            // collection so it holds wherever this collection is mounted, rather than depending on
            // a registration site remembering to pass it.
            before: async (input: never, ctx: never) => {
                const record = input as unknown as { ownerId: string };
                const owner = await (ctx as IServiceContext).db('identity.user').resolve({ id: record.ownerId });
                if (owner === undefined) {
                    throw new MeshError({ message: `No account "${record.ownerId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return record;
            },
        },
    },
    dependencies: ['identity.user'],
    filePath: 'src/identity/contracts/organization.contract.ts',
    permissions: [],
});

export type Organization = z.infer<typeof organizationCrud.outputSchema>;
