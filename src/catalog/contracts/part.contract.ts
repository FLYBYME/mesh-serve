import { defineContract, defineCrud, defineEvent, MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { partSchema } from '../schema/part.js';
import { validatePartKey } from '../methods/partKey.js';
import { resolvePinnedArtifact } from '../methods/partArtifact.js';

/** The fields the hooks below read, parsed out of what the CRUD layer hands them; the rest pass through untouched. */
const partCreateHookInput = z.object({
    tenantId: z.string(),
    key: z.string(),
    artifactId: z.string().optional(),
});
const partUpdateHookInput = z.object({
    id: z.string(),
    key: z.string().optional(),
    artifactId: z.string().optional(),
});

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
            before: async (input: unknown, ctx: IServiceContext) => {
                const record = partCreateHookInput.parse(input);
                await validatePartKey(record, record.tenantId, ctx);
                if (record.artifactId !== undefined) {
                    // A pin names a build *of this part*, and no build of a part can exist before
                    // the part does. Build it, then pin it with serve.part.update.
                    throw new MeshError({
                        message: 'A new part cannot be created with an artifactId; build it first, then set artifactId with serve.part.update.',
                        code: 'BAD_REQUEST',
                        status: 400,
                    });
                }
                return input;
            },
        },
        update: {
            // An update need not carry `key` or `artifactId` at all; only validate what it is
            // actually changing, against the part's own tenant rather than trusting the caller.
            before: async (input: unknown, ctx: IServiceContext) => {
                const record = partUpdateHookInput.parse(input);
                if (record.key === undefined && record.artifactId === undefined) return input;

                const part = await ctx.db('serve.part').resolve({ id: record.id });
                if (part === undefined) {
                    throw new MeshError({ message: `No part "${record.id}".`, code: 'NOT_FOUND', status: 404 });
                }
                if (record.key !== undefined) {
                    await validatePartKey({ key: record.key }, part.tenantId, ctx);
                }
                if (record.artifactId !== undefined) {
                    // Refuse a pin that start could never load, now rather than on the next restart.
                    await resolvePinnedArtifact(ctx, part.id, record.artifactId);
                }
                return input;
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
/**
 * A service part's lifecycle on one node, as it happens -- what an operator used to learn only by
 * SSHing into the node and reading its journal. Scoped by the part's own tenant; an operator's
 * subscription sees every tenant's (see api/methods/delivery.ts).
 */
const partLifecycleFields = {
    tenantId: z.string().describe('The organization that owns the part'),
    partId: z.string(),
    key: z.string().describe('The part key, e.g. "platform/certs"'),
    nodeID: z.string().describe('The node this happened on'),
    artifactId: z.string().optional().describe('The build it was running, when known'),
};

export const partStartedEvent = defineEvent(
    'serve.part.started',
    z.object(partLifecycleFields).describe('A service part started on a node'),
    { scopedBy: 'tenantId' },
);

export const partStoppedEvent = defineEvent(
    'serve.part.stopped',
    z.object(partLifecycleFields).describe('A service part was stopped on a node'),
    { scopedBy: 'tenantId' },
);

export const partFailedEvent = defineEvent(
    'serve.part.failed',
    z.object({ ...partLifecycleFields, error: z.string().describe('Why it failed') })
        .describe('A service part failed to start on a node'),
    { scopedBy: 'tenantId' },
);

export type PartLifecycleEvent = z.infer<typeof partStartedEvent.schema>;
export type PartFailedEvent = z.infer<typeof partFailedEvent.schema>;

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
