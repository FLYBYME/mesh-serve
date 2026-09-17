import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { siteSchema } from '../schema/site.js';

export const siteCrud = defineCrud('serve.cdn', siteSchema, {
    pluralPath: 'sites',
    scopedBy: 'tenantId',
    unique: [
        { fields: 'host', scope: 'global' },
        { fields: 'mcpHost', scope: 'global' },
    ],
    // update: `mesh-serve init -c` reconciles an existing site's `open` array against the config's
    // current application parts on a rerun -- same reasoning as serve.composition (composition.contract.ts).
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public', update: 'public',
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

export const deployInputSchema = z.object({
    siteId: z.string().min(1).describe('The serve.site to deploy to'),
    releaseHash: z.string().min(1).describe('The serve.release to serve'),
}).describe('Point a site at a release it is not currently serving');

export const deployOutputSchema = z.object({
    site: siteCrud.get.outputSchema,
    wantsAdded: z.array(z.string()).describe('Contract keys this release\'s parts want that the site\'s previous release did not'),
    wantsRemoved: z.array(z.string()).describe('Contract keys the site\'s previous release wanted that this one does not'),
}).describe('The result of a deploy');

export const siteDeployContract = defineContract({
    domain: 'serve.cdn',
    action: 'deploy',
    description: 'Point a site at a release it is not currently serving.',
    inputSchema: deployInputSchema,
    outputSchema: deployOutputSchema,
    rest: { method: 'POST', path: '/sites/:siteId/deploy' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.site.host} -> ${o.site.releaseHash}`,
});

export type DeployInput = z.infer<typeof siteDeployContract.inputSchema>;
export type DeployOutput = z.infer<typeof siteDeployContract.outputSchema>;
