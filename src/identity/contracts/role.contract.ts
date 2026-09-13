import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { roleSchema } from '../schema/role.js';

export const roleCrud = defineCrud('identity.role', roleSchema, {
    pluralPath: 'roles',
    unique: [{ fields: 'key', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: [],
});

export type Role = z.infer<typeof roleCrud.outputSchema>;

export const upsertOutputSchema = z.object({
    key: z.string().describe('The role that was defined or changed'),
    created: z.boolean().describe('False when this replaced a role that already existed'),
}).describe('The result of defining or changing a role');

export const roleUpsertContract = defineContract({
    domain: 'identity.role',
    action: 'upsert',
    description: 'Define a role, or change one. Refuses an inheritance edge that cycles or crosses scope.',
    inputSchema: roleSchema,
    outputSchema: upsertOutputSchema,
    rest: { method: 'POST', path: '/identity/roles/define' },
    dependencies: ['identity.role'],
    visibility: 'public',
    print: (o) => `${o.key} ${o.created ? 'defined' : 'updated'}`,
});

export type UpsertInput = z.infer<typeof roleUpsertContract.inputSchema>;
export type UpsertOutput = z.infer<typeof roleUpsertContract.outputSchema>;
