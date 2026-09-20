import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { releaseArtifactSchema, releaseSchema } from '../schema/release.js';
import { computeReleaseHash } from '../methods/release.js';

export const releaseCrud = defineCrud('serve.release', releaseSchema, {
    pluralPath: 'releases',
    scopedBy: 'tenantId',
    unique: [{ fields: 'hash', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    hooks: {
        create: {
            // A release is identified by the content it pins, so its hash is derived, not supplied
            // -- unless the caller already computed the same thing and passed it.
            before: (input: never) => {
                const record = input as unknown as { hash?: string; compositionId: string; artifacts: ReleaseArtifact[] };
                if (record.hash !== undefined) return record;
                return { ...record, hash: computeReleaseHash(record.compositionId, record.artifacts) };
            },
        },
    },
    dependencies: ['serve.composition', 'serve.artifact'],
    filePath: 'src/catalog/contracts/release.contract.ts',
    permissions: [],
});

export type Release = z.infer<typeof releaseCrud.outputSchema>;
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

export const getReleaseInputSchema = z.object({
    hash: z.string().min(1).describe('The release hash a site points at'),
}).describe('One release, by hash, for an anonymous connection');

export const getReleaseOutputSchema = releaseCrud.get.outputSchema;

export const releaseGetReleaseContract = defineContract({
    domain: 'serve.release',
    action: 'getRelease',
    description: 'One release, by hash, for an anonymous connection.',
    inputSchema: getReleaseInputSchema,
    outputSchema: getReleaseOutputSchema,
    rest: { method: 'GET', path: '/releases/:hash' },
    visibility: 'public',
    filePath: 'src/catalog/tools/getRelease.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.hash} (${o.compositionId})`,
});

export type GetReleaseInput = z.infer<typeof releaseGetReleaseContract.inputSchema>;
export type GetReleaseOutput = z.infer<typeof releaseGetReleaseContract.outputSchema>;
