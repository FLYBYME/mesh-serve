import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { artifactSchema } from '../schema/artifact.js';

export const artifactCrud = defineCrud('serve.artifact', artifactSchema, {
    pluralPath: 'artifacts',
    scopedBy: 'tenantId',
    // Reads only -- create/update/delete stay internal, behind the validated requestBuild tool
    // (resolving the part, checking driver kinds, defaulting status). Same gap as repo/part/
    // composition had (visibility: {} meant nothing here was reachable over HTTP at all, for
    // anyone, ever) -- found live checking a build's status from the CLI instead of raw Mongo.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: ['serve.part'],
    filePath: 'src/catalog/contracts/artifact.contract.ts',
    permissions: [],
});

export type Artifact = z.infer<typeof artifactCrud.outputSchema>;

export const artifactBuiltEventSchema = z.object({
    tenantId: z.string().describe('The organization that owns this artifact'),
    artifact: artifactCrud.get.outputSchema.describe('The artifact that finished building'),
    hash: z.string().describe('The content hash of the built output'),
    assets: z.array(z.object({
        url: z.string(),
        name: z.string(),
        fileExtension: z.string().optional(),
    })).describe('Every file this artifact serves'),
}).describe('An artifact finished building successfully');

export const artifactBuiltEvent = defineEvent(
    'serve.artifact.built',
    artifactBuiltEventSchema,
    { scopedBy: 'tenantId' },
);

export type ArtifactBuiltEvent = z.infer<typeof artifactBuiltEventSchema>;

export const artifactBuildFailedEventSchema = z.object({
    tenantId: z.string().describe('The organization that owns this artifact'),
    artifact: artifactCrud.get.outputSchema.describe('The artifact that failed to build'),
    error: z.string().describe('What went wrong'),
}).describe('An artifact failed to build');

export const artifactBuildFailedEvent = defineEvent(
    'serve.artifact.buildFailed',
    artifactBuildFailedEventSchema,
    { scopedBy: 'tenantId' },
);

export type ArtifactBuildFailedEvent = z.infer<typeof artifactBuildFailedEventSchema>;

export const getArtifactInputSchema = z.object({
    hash: z.string().min(1).describe('The artifact hash a release pins'),
}).describe('One artifact, by hash, for an anonymous connection');

export const getArtifactOutputSchema = artifactCrud.get.outputSchema;

export const artifactGetArtifactContract = defineContract({
    domain: 'serve.artifact',
    action: 'getArtifact',
    description: 'One artifact, by hash, for an anonymous connection.',
    inputSchema: getArtifactInputSchema,
    outputSchema: getArtifactOutputSchema,
    rest: { method: 'GET', path: '/artifacts/:hash' },
    visibility: 'public',
    filePath: 'src/catalog/tools/getArtifact.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.hash ?? o.id} (${o.status})`,
});

export type GetArtifactInput = z.infer<typeof artifactGetArtifactContract.inputSchema>;
export type GetArtifactOutput = z.infer<typeof artifactGetArtifactContract.outputSchema>;

export const getAssetInputSchema = z.object({
    artifactHash: z.string().min(1).describe('The artifact hash a file lives under'),
    path: z.string().min(1).describe('The path to the asset within that artifact'),
}).describe('Get one file out of a built artifact by path');

export const getAssetOutputSchema = z.object({
    name: z.string().describe('The name of the asset'),
    path: z.string().describe('The path to the asset'),
    contentType: z.string().describe('The content type of the asset'),
    contentLength: z.number().describe('The content length of the asset'),
    lastModified: z.string().describe('The last modified date of the asset'),
    eTag: z.string().optional().describe('The ETag of the asset'),
    fileExtension: z.string().optional().describe('The file extension of the asset'),
    size: z.number().optional().describe('The size of the asset in bytes'),
}).describe('Artifact asset file');

export const artifactGetAssetContract = defineContract({
    domain: 'serve.artifact',
    action: 'getAsset',
    description: 'Get one file out of a built artifact by path.',
    inputSchema: getAssetInputSchema,
    outputSchema: getAssetOutputSchema,
    rest: { method: 'GET', path: '/artifacts/:artifactHash/assets/:path' },
    visibility: 'public',
    filePath: 'src/catalog/tools/getAsset.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.name} ${o.path}`,
});

export type GetAssetInput = z.infer<typeof artifactGetAssetContract.inputSchema>;
export type GetAssetOutput = z.infer<typeof artifactGetAssetContract.outputSchema>;

export const requestBuildInputSchema = z.object({
    partId: z.string().min(1).describe('The serve.part to build -- kernel, driver, application, extension, and theme are all queued the same way'),
    ref: z.string().min(1).describe('The git ref to build at'),
    drivers: z.array(z.string()).optional().describe('serve.part (kind: driver) keys to bake in; only valid when partId names a kind: kernel part'),
}).describe('Queue a build of one part at one ref');

export const requestBuildOutputSchema = artifactCrud.get.outputSchema;

export const artifactRequestBuildContract = defineContract({
    domain: 'serve.artifact',
    action: 'requestBuild',
    description: 'Queue a build of one part at one ref.',
    inputSchema: requestBuildInputSchema,
    outputSchema: requestBuildOutputSchema,
    rest: { method: 'POST', path: '/artifacts/requestBuild' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/catalog/tools/requestBuild.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.id} (${o.status})`,
});

export type RequestBuildInput = z.infer<typeof artifactRequestBuildContract.inputSchema>;
export type RequestBuildOutput = z.infer<typeof artifactRequestBuildContract.outputSchema>;

export const buildInputSchema = z.object({
    id: z.string().min(1).describe('The already-created (status: pending) artifact to actually build'),
}).describe('Run one already-queued build -- dispatched by serve.queue, not called directly');

export const buildOutputSchema = z.object({
    success: z.boolean(),
    duration: z.number(),
    hash: z.string().optional(),
});

/**
 * Internal (the default -- no visibility set): dispatched only in-process, by serve.queue's own
 * claim loop, never over HTTP. requestBuild is the public surface that creates the (status:
 * pending) row; this is what watchRelease used to do inline, serially, for every pending row it
 * found -- now it just enqueues one of these per row instead.
 */
export const artifactBuildContract = defineContract({
    domain: 'serve.artifact',
    action: 'build',
    description: 'Run one already-queued build.',
    inputSchema: buildInputSchema,
    outputSchema: buildOutputSchema,
    rest: { method: 'POST', path: '/artifacts/build' },
    destructive: true,
    // Matches CatalogService.BUILD_TIMEOUT_MS -- serve.queue always passes an explicit timeout
    // that overrides this, but a direct ctx.call (tests, a future non-queue caller) still wants a
    // sane bound rather than whatever the framework's own default is.
    timeout: 5 * 60_000,
    filePath: 'src/catalog/tools/build.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.success ? 'built' : 'build failed'),
});

export type BuildInput = z.infer<typeof artifactBuildContract.inputSchema>;
export type BuildOutput = z.infer<typeof artifactBuildContract.outputSchema>;

export const watchReleaseOutputSchema = z.object({
    enqueued: z.number().describe('Pending artifacts handed to serve.queue by this sweep'),
}).describe('What one build sweep found');

/**
 * The pending-artifact sweep, as an interval contract: the broker owns the 60s timer, so there is
 * no `watchInterval` field and no `clearInterval` in an `onStop` to remember.
 *
 * Not `leaderScoped`, deliberately -- the sweep flips each artifact to 'running' before enqueuing
 * it, so two nodes sweeping concurrently cannot enqueue the same artifact twice, and the write
 * itself is what serializes them.
 */
export const artifactWatchReleaseContract = defineContract({
    domain: 'serve.artifact',
    action: 'watchRelease',
    description: 'Find pending artifacts across every tenant and enqueue a build for each.',
    inputSchema: z.object({}),
    outputSchema: watchReleaseOutputSchema,
    rest: { method: 'POST', path: '/artifacts/watch' },
    destructive: true,
    dependencies: ['serve.artifact', 'serve.queue'],
    filePath: 'src/catalog/tools/watchRelease.ts',
    concurrency: 'interval',
    intervalMs: 60_000,
    permissions: [],
    print: (o) => `enqueued ${o.enqueued}`,
});

export type WatchReleaseOutput = z.infer<typeof artifactWatchReleaseContract.outputSchema>;
