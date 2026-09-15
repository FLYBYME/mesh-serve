import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { apiSchema } from '../schema/api.js';

export const apiCrud = defineCrud('serve.api', apiSchema, {
    pluralPath: 'apis',
    scopedBy: 'tenantId',
    unique: [{ fields: 'apiHost', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: [],
});

export type Api = z.infer<typeof apiCrud.outputSchema>;

export const resolveApiByIdInputSchema = z.object({
    id: z.string().min(1).describe('The api id'),
}).describe('One api, by id, for a caller who does not yet know its tenant');

export const resolveApiByIdOutputSchema = apiCrud.get.outputSchema;

export const apiResolveByIdContract = defineContract({
    domain: 'serve.api',
    action: 'resolveById',
    description: 'One api, by id, for a caller who does not yet know its tenant.',
    inputSchema: resolveApiByIdInputSchema,
    outputSchema: resolveApiByIdOutputSchema,
    rest: { method: 'GET', path: '/apis/id/:id' },
    visibility: 'public',
    print: (o) => `${o.apiHost} (${o.tenantId})`,
});

export type ResolveApiByIdInput = z.infer<typeof apiResolveByIdContract.inputSchema>;
export type ResolveApiByIdOutput = z.infer<typeof apiResolveByIdContract.outputSchema>;

export const resolveApiByHostInputSchema = z.object({
    apiHost: z.string().min(1).describe('The hostname an api connection arrived on'),
}).describe('One api, by hostname, for an anonymous connection');

export const resolveApiByHostOutputSchema = apiCrud.get.outputSchema;

export const apiResolveByHostContract = defineContract({
    domain: 'serve.api',
    action: 'resolveByHost',
    description: 'One api, by hostname, for an anonymous connection.',
    inputSchema: resolveApiByHostInputSchema,
    outputSchema: resolveApiByHostOutputSchema,
    rest: { method: 'GET', path: '/apis/host/:apiHost' },
    visibility: 'public',
    print: (o) => `${o.apiHost} (${o.tenantId})`,
});

export type ResolveApiByHostInput = z.infer<typeof apiResolveByHostContract.inputSchema>;
export type ResolveApiByHostOutput = z.infer<typeof apiResolveByHostContract.outputSchema>;
