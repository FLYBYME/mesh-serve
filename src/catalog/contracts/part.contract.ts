import { defineContract, defineCrud, MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { partSchema } from '../schema/part.js';
import { validatePartKey } from '../methods/partKey.js';

export const partCrud = defineCrud('serve.part', partSchema, {
    pluralPath: 'parts',
    scopedBy: 'tenantId',
    // key is namespaced "org-slug/part-name" (enforced by the create/update hooks below), so it's
    // already globally disambiguated -- global uniqueness matches that, not tenant-scoped.
    unique: [{ fields: 'key', scope: 'global' }],
    // update: the same key-prefix check `create` uses applies to it, and `mesh-serve init -c` needs
    // it to reconcile a rerun against a config that changed which repo, path, entry point, or kind
    // an existing part's key now points at -- `create` alone only ever covers a genuinely new key,
    // so the existing row silently kept its stale fields otherwise.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public', update: 'public',
    },
    hooks: {
        create: {
            before: async (input: never, ctx: never) => {
                const record = input as unknown as { tenantId: string; key: string };
                await validatePartKey(record, record.tenantId, ctx as IServiceContext);
                return record;
            },
        },
        update: {
            // An update need not carry `key` at all; only validate when it is actually changing
            // one, and resolve the part's own tenant rather than trusting the caller for it.
            before: async (input: never, ctx: never) => {
                const record = input as unknown as { id: string; key?: string };
                if (record.key === undefined) return record;

                const part = await (ctx as IServiceContext).db('serve.part').resolve({ id: record.id });
                if (part === undefined) {
                    throw new MeshError({ message: `No part "${record.id}".`, code: 'NOT_FOUND', status: 404 });
                }
                await validatePartKey({ key: record.key }, part.tenantId, ctx as IServiceContext);
                return record;
            },
        },
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
    // Runs code on a node. There is no larger blast radius in the system.
    filePath: 'src/catalog/tools/startService.ts', concurrency: 'on-demand', permissions: ['operator'],
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
    filePath: 'src/catalog/tools/stopService.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: () => 'stopped',
});

export type PartStopInput = z.infer<typeof partStopContract.inputSchema>;
export type PartStopOutput = z.infer<typeof partStopContract.outputSchema>;
