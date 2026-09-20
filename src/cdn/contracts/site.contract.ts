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
    hooks: {
        create: {
            // mcpHost defaults to the site's own host with an mcp- prefix. Declared here rather
            // than wired at registration time so it travels with the collection -- there is no
            // longer any per-service registration code for it to live in.
            before: (input: never) => {
                const record = input as unknown as { mcpHost?: string; host: string };
                if (record.mcpHost !== undefined) return record;
                return { ...record, mcpHost: `mcp-${record.host}` };
            },
        },
    },
    dependencies: [],
    filePath: 'src/cdn/contracts/site.contract.ts',
    permissions: [],
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
    filePath: 'src/cdn/tools/resolveHost.ts', concurrency: 'on-demand', permissions: [],
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
    filePath: 'src/cdn/tools/resolveById.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.host} (${o.tenantId})`,
});

export type ResolveByIdInput = z.infer<typeof siteResolveByIdContract.inputSchema>;
export type ResolveByIdOutput = z.infer<typeof siteResolveByIdContract.outputSchema>;

export const deployInputSchema = z.object({
    siteId: z.string().min(1).describe('The serve.site to deploy to'),
    releaseId: z.string().min(1).describe('The serve.release to serve'),
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
    // Changes what a live site serves to everyone who visits it.
    filePath: 'src/cdn/tools/deploy.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.site.host} -> ${o.site.releaseHash}`,
});

export type DeployInput = z.infer<typeof siteDeployContract.inputSchema>;
export type DeployOutput = z.infer<typeof siteDeployContract.outputSchema>;

/**
 * The frontend HTTP listener, as a contract.
 *
 * This is the `long-running` case the concurrency field was added for: the handler binds a port
 * and returns immediately, and the listener stays up until `ctx.signal` aborts -- which happens
 * when the contract is unregistered or the node stops. There is no `onStart`/`onStop` pair and
 * nothing holds the `http.Server` except the closure that registered its `close()`.
 *
 * Being a contract rather than a side effect of loading the part is what makes it *placeable*:
 * once the scheduler exists, deciding which node serves frontend traffic is deciding where to
 * call this. Until then `register()` calls it locally, which is exactly what `onStart` did.
 */
export const siteListenContract = defineContract({
    domain: 'serve.cdn',
    action: 'listen',
    description: 'Bind the frontend HTTP listener on this node and serve sites until stopped.',
    inputSchema: z.object({
        port: z.number().optional().describe('Defaults to SERVER_PORT, then 3123'),
        host: z.string().optional().describe('Defaults to SERVER_HOST, then ::'),
    }),
    outputSchema: z.object({
        boundTo: z.string().describe('host:port actually bound'),
        nodeID: z.string(),
    }),
    rest: { method: 'POST', path: '/cdn/listen' },
    destructive: true,
    filePath: 'src/cdn/tools/listen.ts',
    concurrency: 'long-running',
    permissions: ['operator'],
    print: (o) => `serving on ${o.boundTo} (${o.nodeID})`,
});

export type SiteListenInput = z.infer<typeof siteListenContract.inputSchema>;
export type SiteListenOutput = z.infer<typeof siteListenContract.outputSchema>;
