import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { roleSchema } from '../schema/role.js';

export const roleCrud = defineCrud('identity.role', roleSchema, {
    pluralPath: 'roles',
    unique: [{ fields: 'key', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: [],
    filePath: 'src/identity/contracts/role.contract.ts',
    permissions: [],
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
    // Defines what a role may do. Whoever can call this can grant themselves anything.
    filePath: 'src/identity/tools/upsertRole.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.key} ${o.created ? 'defined' : 'updated'}`,
});

export type UpsertInput = z.infer<typeof roleUpsertContract.inputSchema>;
export type UpsertOutput = z.infer<typeof roleUpsertContract.outputSchema>;

export const ensureBuiltinsOutputSchema = z.object({
    created: z.array(z.string()).describe('Role keys that did not exist and were created'),
    existing: z.array(z.string()).describe('Role keys that were already present and left untouched'),
}).describe('What seeding the builtin roles actually did');

/**
 * Seeds the four builtin roles, create-if-missing.
 *
 * A contract rather than something that runs when the identity part loads, because it is a *write
 * to shared cluster state* and loading is per node: five nodes loading identity would mean five
 * racing seed loops on every boot. Bootstrap is the one step that deliberately reaches into the
 * mesh, and it calls this once. Still idempotent -- an existing row is left exactly as it is,
 * including an operator's own customization (identity.role.upsert is the explicit way to change a
 * builtin role) -- so calling it again is safe, just unnecessary.
 */
export const roleEnsureBuiltinsContract = defineContract({
    domain: 'identity.role',
    action: 'ensureBuiltins',
    description: 'Create any of the four builtin roles that do not exist yet, leaving existing ones untouched.',
    inputSchema: z.object({}),
    outputSchema: ensureBuiltinsOutputSchema,
    rest: { method: 'POST', path: '/identity/roles/ensure-builtins' },
    dependencies: ['identity.role'],
    destructive: true,
    filePath: 'src/identity/tools/ensureBuiltins.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => (o.created.length === 0 ? 'all builtin roles present' : `created ${o.created.join(', ')}`),
});

export type EnsureBuiltinsOutput = z.infer<typeof roleEnsureBuiltinsContract.outputSchema>;
