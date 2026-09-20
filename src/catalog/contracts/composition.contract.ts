import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { compositionSchema } from '../schema/composition.js';
import { releaseCrud } from './release.contract.js';

export const compositionCrud = defineCrud('serve.composition', compositionSchema, {
    pluralPath: 'compositions',
    scopedBy: 'tenantId',
    unique: [{ fields: 'key', scope: 'scoped' }],
    // update: same reasoning as serve.repo/serve.part -- `mesh-serve init -c` reconciles a
    // composition's declared parts/kernelPartKey against what's already there on a rerun. Found
    // live: a part added to a config after the composition already existed silently never made it
    // into the release, because findOrCreate had nothing to reconcile with on a conflict.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public', update: 'public',
    },
    dependencies: ['serve.part'],
    filePath: 'src/catalog/contracts/composition.contract.ts',
    permissions: [],
});

export type Composition = z.infer<typeof compositionCrud.outputSchema>;

export const composeInputSchema = z.object({
    id: z.string().min(1).describe('The serve.composition to pin a release for'),
}).describe('Pin a release from a composition\'s current, successfully built parts');

export const composeOutputSchema = releaseCrud.get.outputSchema;

export const compositionComposeContract = defineContract({
    domain: 'serve.composition',
    action: 'compose',
    description: 'Pin a release from a composition\'s current, successfully built parts.',
    inputSchema: composeInputSchema,
    outputSchema: composeOutputSchema,
    rest: { method: 'POST', path: '/compositions/:id/compose' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/catalog/tools/compose.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.hash} (${o.artifacts.length} artifacts)`,
});

export type ComposeInput = z.infer<typeof compositionComposeContract.inputSchema>;
export type ComposeOutput = z.infer<typeof compositionComposeContract.outputSchema>;
