import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { partSchema } from '../schema/part.js';

export const partCrud = defineCrud('serve.part', partSchema, {
    pluralPath: 'parts',
    scopedBy: 'tenantId',
    // key is namespaced "org-slug/part-name" (enforced in catalog.service.ts's create/update hooks),
    // so it's already globally disambiguated -- global uniqueness matches that, not tenant-scoped.
    unique: [{ fields: 'key', scope: 'global' }],
    // update: catalog.service.ts already validates it (the same key-prefix hook `create` uses), and
    // `mesh-serve init -c` needs it to reconcile a rerun against a config that changed which repo,
    // path, entry point, or kind an existing part's key now points at -- `create` alone only ever
    // covers a genuinely new key, so the existing row silently kept its stale fields otherwise.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public', update: 'public',
    },
    dependencies: ['serve.repo'],
    filePath: 'src/catalog/contracts/part.contract.ts',
    permissions: [],
});

export type Part = z.infer<typeof partCrud.outputSchema>;

export const partStartInputSchema = z.object({
    id: z.string().min(1).describe('The serve.part (kind: service) to load into this node'),
}).describe('Load a service part into this node: imports its latest successful build and registers it with this node\'s own broker');

export const partStartOutputSchema = z.object({
    domain: z.string().describe('The mount key the service registered under on this node'),
    nodeID: z.string().describe('This node\'s own id -- useful when the caller routed here by some other means and wants to confirm which node actually loaded it'),
}).describe('The result of starting a service on this node');

/**
 * This contract only ever knows about the node it runs on -- there is deliberately no `nodeID`
 * field in its input. Targeting a specific node is `ctx.call`'s own job (the `nodeID` call option,
 * resolved against the mesh's node registry), the same mechanism every other cross-node call in
 * this framework already uses; duplicating that as a contract field would be a second way to say
 * the same thing and a way for the two to disagree.
 */
export const partStartContract = defineContract({
    domain: 'serve.part',
    action: 'start',
    description: 'Load a service part into this node, importing its latest successful build and registering it with the broker.',
    inputSchema: partStartInputSchema,
    outputSchema: partStartOutputSchema,
    rest: { method: 'POST', path: '/parts/:id/start' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/catalog/contracts/part.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.domain} started on ${o.nodeID}`,
});

export type PartStartInput = z.infer<typeof partStartContract.inputSchema>;
export type PartStartOutput = z.infer<typeof partStartContract.outputSchema>;

export const partStopInputSchema = z.object({
    id: z.string().min(1).describe('The serve.part (kind: service) to unload from this node'),
}).describe('Stop a service this node is currently running');

export const partStopOutputSchema = z.object({
    stopped: z.literal(true).describe('Always true; the call throws instead of answering false'),
}).describe('The result of stopping a service on this node');

export const partStopContract = defineContract({
    domain: 'serve.part',
    action: 'stop',
    description: 'Stop a service this node is currently running, unregistering it from this node\'s own broker.',
    inputSchema: partStopInputSchema,
    outputSchema: partStopOutputSchema,
    rest: { method: 'POST', path: '/parts/:id/stop' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/catalog/contracts/part.contract.ts', concurrency: 'on-demand', permissions: [],
    print: () => 'stopped',
});

export type PartStopInput = z.infer<typeof partStopContract.inputSchema>;
export type PartStopOutput = z.infer<typeof partStopContract.outputSchema>;
