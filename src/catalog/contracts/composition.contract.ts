import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { compositionSchema } from '../schema/composition.js';
import { releaseCrud } from './release.contract.js';

export const compositionCrud = defineCrud('serve.composition', compositionSchema, {
    pluralPath: 'compositions',
    scopedBy: 'tenantId',
    unique: [{ fields: 'key', scope: 'scoped' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: ['serve.part'],
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
    print: (o) => `${o.hash} (${o.parts.length} parts)`,
});

export type ComposeInput = z.infer<typeof compositionComposeContract.inputSchema>;
export type ComposeOutput = z.infer<typeof compositionComposeContract.outputSchema>;
