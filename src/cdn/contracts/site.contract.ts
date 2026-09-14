import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { siteSchema } from '../schema/site.js';

export const siteCrud = defineCrud('serve.cdn', siteSchema, {
    pluralPath: 'sites',
    scopedBy: 'tenantId',
    unique: [
        { fields: 'host', scope: 'global' },
        { fields: 'apiHost', scope: 'global' },
        { fields: 'mcpHost', scope: 'global' },
    ],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: [],
});

export type Site = z.infer<typeof siteCrud.outputSchema>;

export const resolveHostInputSchema = z.object({
    host: z.string().min(1).describe('The hostname a connection arrived on'),
}).describe('One site, by hostname, for an anonymous connection');

export const resolveHostOutputSchema = siteCrud.get.outputSchema;

export const siteResolveHostContract = defineContract({
    domain: 'serve.cdn',
    action: 'resolveHost',
    description: 'One site, by hostname, for an anonymous connection.',
    inputSchema: resolveHostInputSchema,
    outputSchema: resolveHostOutputSchema,
    rest: { method: 'GET', path: '/sites/:host' },
    visibility: 'public',
    print: (o) => `${o.host} (${o.tenantId})`,
});

export type ResolveHostInput = z.infer<typeof siteResolveHostContract.inputSchema>;
export type ResolveHostOutput = z.infer<typeof siteResolveHostContract.outputSchema>;

export const resolveApiHostInputSchema = z.object({
    apiHost: z.string().min(1).describe('The hostname an api connection arrived on'),
}).describe('One site, by api hostname, for an anonymous connection');

export const resolveApiHostOutputSchema = siteCrud.get.outputSchema;

export const siteResolveApiHostContract = defineContract({
    domain: 'serve.cdn',
    action: 'resolveApiHost',
    description: 'One site, by api hostname, for an anonymous connection.',
    inputSchema: resolveApiHostInputSchema,
    outputSchema: resolveApiHostOutputSchema,
    rest: { method: 'GET', path: '/sites/api/:apiHost' },
    visibility: 'public',
    print: (o) => `${o.apiHost} (${o.tenantId})`,
});

export type ResolveApiHostInput = z.infer<typeof siteResolveApiHostContract.inputSchema>;
export type ResolveApiHostOutput = z.infer<typeof siteResolveApiHostContract.outputSchema>;

export const resolveByIdInputSchema = z.object({
    id: z.string().min(1).describe('The site id'),
}).describe('One site, by id, for a caller who does not yet know its tenant');

export const resolveByIdOutputSchema = siteCrud.get.outputSchema;

export const siteResolveByIdContract = defineContract({
    domain: 'serve.cdn',
    action: 'resolveById',
    description: 'One site, by id, for a caller who does not yet know its tenant.',
    inputSchema: resolveByIdInputSchema,
    outputSchema: resolveByIdOutputSchema,
    rest: { method: 'GET', path: '/sites/id/:id' },
    visibility: 'public',
    print: (o) => `${o.host} (${o.tenantId})`,
});

export type ResolveByIdInput = z.infer<typeof siteResolveByIdContract.inputSchema>;
export type ResolveByIdOutput = z.infer<typeof siteResolveByIdContract.outputSchema>;
