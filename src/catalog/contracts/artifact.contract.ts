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

export const fetchAssetBytesInputSchema = z.object({
    artifactHash: z.string().min(1).describe('The artifact hash a file lives under'),
    path: z.string().min(1).describe('The path to the asset within that artifact'),
}).describe('One file\'s real bytes out of a built artifact, for another node to copy locally');

export const fetchAssetBytesOutputSchema = z.object({
    contentBase64: z.string().describe('The file\'s exact bytes, base64-encoded'),
}).describe('One artifact asset file\'s content');

/**
 * Internal (no `visibility`), like `serve.corePart.load`: this moves a build's real bytes between
 * two nodes' own disks, never something an ordinary api caller has a reason to call directly.
 * `startService.ts` is the one caller -- when it goes to start a `kind: 'service'` part whose
 * artifact was built on a *different* node than the one asked to run it (~/.mesh/artifacts is
 * node-local, never replicated), it calls this once per asset, targeted at `artifact.builtOn` via
 * the same `nodeID` call option every other cross-node call in this framework already uses, and
 * writes the result into its own local artifact store under the same content hash before loading.
 */
export const artifactFetchAssetBytesContract = defineContract({
    domain: 'serve.artifact',
    action: 'fetchAssetBytes',
    description: 'Read one artifact asset\'s real bytes off this node\'s own disk, for another node to copy.',
    inputSchema: fetchAssetBytesInputSchema,
    outputSchema: fetchAssetBytesOutputSchema,
    rest: { method: 'GET', path: '/artifacts/:artifactHash/assets/:path/bytes' },
    filePath: 'src/catalog/tools/fetchAssetBytes.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.contentBase64.length} base64 chars`,
});

/**
 * Internal, like fetchAssetBytes: the website's way to get a build it does not have. `cdn/gateway.ts`
 * calls it on its own node, with the site's tenant, when a request names a file that is not on this
 * node's disk; it copies the whole build from a node that built it (methods/pullArtifact.ts) and
 * the request is answered from the local copy. A build already here returns at once.
 */
export const artifactPullContract = defineContract({
    domain: 'serve.artifact',
    action: 'pull',
    description: 'Copy a build onto this node\'s own disk from a node that built it, if it is not here already.',
    inputSchema: z.object({ artifactHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The build\'s content hash') }),
    outputSchema: z.object({
        artifactHash: z.string(),
        from: z.string().describe('The node it was copied from, or "local" when it was already here'),
    }),
    rest: { method: 'POST', path: '/artifacts/:artifactHash/pull' },
    filePath: 'src/catalog/tools/pull.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.artifactHash.slice(0, 12)} from ${o.from}`,
});

export type FetchAssetBytesInput = z.infer<typeof artifactFetchAssetBytesContract.inputSchema>;
export type FetchAssetBytesOutput = z.infer<typeof artifactFetchAssetBytesContract.outputSchema>;

export const requestBuildInputSchema = z.object({
    partId: z.string().min(1).describe('The serve.part to build -- kernel, driver, application, extension, and theme are all queued the same way'),
    ref: z.string().min(1).describe('The git ref to build at'),
    drivers: z.array(z.string()).optional().describe('serve.part (kind: driver) keys to bake in; only valid when partId names a kind: kernel part'),
    pin: z.boolean().default(false).describe('Automatically pin the part to this artifact when the build succeeds'),
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
    // A build clones a repo and runs its toolchain, so this is arbitrary code execution by proxy.
    filePath: 'src/catalog/tools/requestBuild.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.id} (${o.status})`,
});

export const importInputSchema = z.object({
    partId: z.string().min(1).describe('The serve.part this is a build of'),
    ref: z.string().min(1).describe('The git ref it was built from'),
    commit: z.string().regex(/^[0-9a-f]{40}$/).describe('The exact commit that ref resolved to'),
    hash: z.string().regex(/^[0-9a-f]{64}$/).describe('The build\'s content hash, as the builder computed it -- checked against the files'),
    wants: z.array(z.string()).optional().describe('The contracts the part calls (mesh.wants.json at build time), as the builder records them on the part'),
    files: z.array(z.object({
        path: z.string().min(1).describe('Relative path inside the build, forward slashes, e.g. "register.js"'),
        contentBase64: z.string().describe('The file\'s exact bytes'),
    })).min(1).describe('Every file of the build'),
    pin: z.boolean().default(false).describe('Pin the part to this build once it is stored'),
}).describe('A build made outside with the builder\'s own code (mesh-serve artifact-build)');

/**
 * Brings in a build made outside -- `mesh-serve artifact-build`, which runs the builder's own
 * `buildService`/`buildPart` -- as if the queue had built it: owner, 2026-09-28, for the very first
 * builds of a fresh install (no builder exists yet) and any time a build is made elsewhere. The
 * content hash and every file's integrity are recomputed from the files themselves
 * (`methods/build.ts` `hashOutput`, the builder's own function); anything that does not match is
 * refused. Stored on the node that runs this, recorded `builtOn` that node, so every other node
 * pulls it from there exactly like a queue build.
 */
export const artifactImportContract = defineContract({
    domain: 'serve.artifact',
    action: 'importBuild',
    description: 'Bring in a build made outside with the builder\'s own code, checked against its hash, as a successful build.',
    inputSchema: importInputSchema,
    outputSchema: artifactCrud.get.outputSchema,
    rest: { method: 'POST', path: '/artifacts/importBuild' },
    visibility: 'public',
    destructive: true,
    // What it stores is code a node will run: as trusted as requestBuild, and gated the same.
    filePath: 'src/catalog/tools/importArtifact.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.id} ${o.hash?.slice(0, 12) ?? ''} (${o.status})`,
    timeout: 120_000,
});

export type ImportArtifactInput = z.infer<typeof artifactImportContract.inputSchema>;

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
    filePath: 'src/catalog/tools/build.ts', concurrency: 'on-demand', permissions: ['operator'],
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
 * `leaderScoped`, so exactly one node sweeps however many are running it.
 *
 * It was not, on the theory that flipping each artifact to 'running' before enqueuing made
 * concurrent sweeps safe -- "the write itself is what serializes them". That is false, and the
 * two-node cluster is where it stops being theoretical: the sweep does a plain `find` for
 * `status: 'pending'` and *then* an unconditional update, so two nodes both see the same artifact,
 * both mark it running, and both enqueue a build for it. The build then runs twice, and since
 * `maxAttempts: 1` neither looks like a retry.
 *
 * Nothing extra is needed to enforce this: `ServiceBroker.startIntervalContract` checks
 * `leaderFor` before each tick and drops it on a non-leader, so every node still *loads* the
 * contract and only the leader acts -- and leadership moving is picked up on the next tick rather
 * than needing anything to watch for it.
 */
export const artifactWatchReleaseContract = defineContract({
    domain: 'serve.artifact',
    action: 'watchRelease',
    description: 'Find pending artifacts across every tenant and enqueue a build for each.',
    inputSchema: z.object({}),
    outputSchema: watchReleaseOutputSchema,
    rest: { method: 'POST', path: '/artifacts/watch' },
    destructive: true,
    leaderScoped: true,
    dependencies: ['serve.artifact', 'serve.queue'],
    filePath: 'src/catalog/tools/watchRelease.ts',
    concurrency: 'interval',
    intervalMs: 15_000,
    permissions: ['operator'],
    print: (o) => `enqueued ${o.enqueued}`,
});

export type WatchReleaseOutput = z.infer<typeof artifactWatchReleaseContract.outputSchema>;

const pruneOutputSchema = z.object({
    dryRun: z.boolean(),
    kept: z.number().int().describe('Builds whose files stay in the database'),
    removed: z.number().int().describe('Builds whose files were (or, dry run, would be) removed'),
    files: z.number().int(),
    bytes: z.number().int(),
});
export type PruneArtifactsOutput = z.infer<typeof pruneOutputSchema>;

/**
 * Removes stored build files nothing needs: not pinned, not among a part's newest builds or a
 * composition's newest releases, not just built (methods/artifactRetention.ts). The records stay.
 * Found needed 2026-10-01: build files were the largest thing in a full 512 MB database.
 */
export const artifactPruneContract = defineContract({
    domain: 'serve.artifact',
    action: 'prune',
    description: 'Removes the stored files of builds nothing needs -- keeps every pinned build, each part\'s newest 3, every build in each composition\'s newest 3 releases, and anything built in the last hour. Records stay. dryRun reports without removing.',
    inputSchema: z.object({ dryRun: z.boolean().optional().describe('Report what would go, remove nothing') }),
    outputSchema: pruneOutputSchema,
    rest: { method: 'POST', path: '/artifacts/prune' },
    destructive: true,
    // Offered to operators through an api: without it the contract is internal and refused there.
    visibility: 'public',
    dependencies: ['serve.artifact', 'serve.part', 'serve.release'],
    filePath: 'src/catalog/tools/pruneArtifacts.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.dryRun ? 'would remove' : 'removed'} ${o.removed} builds (${Math.round(o.bytes / 1e6)} MB), kept ${o.kept}`,
    timeout: 300_000,
});

const moveOffDatabaseOutputSchema = z.object({
    dryRun: z.boolean(),
    moved: z.number().int().describe('Builds now on enough node disks, their database files removed (or, dry run, that would be tried)'),
    dropped: z.number().int().describe('Builds nothing keeps, their database files removed'),
    short: z.array(z.string()).describe('Builds left in the database: not on enough nodes, with why'),
    left: z.number().int().describe('Builds still in the database after this call (call again)'),
    bytes: z.number().int().describe('Database bytes freed'),
});
export type MoveOffDatabaseOutput = z.infer<typeof moveOffDatabaseOutputSchema>;

/**
 * Builds out of the database, onto node disks (owner, 10-09: 136 of 169 MB of it was build files).
 * For each build still in GridFS: one retention keeps is copied to ARTIFACT_COPIES nodes, each
 * holder checked by asking it to pull (methods/spreadArtifact.ts), and only then are its database
 * files removed; one nothing keeps just loses its files, as prune would. `limit` builds per call.
 */
export const artifactMoveOffDatabaseContract = defineContract({
    domain: 'serve.artifact',
    action: 'moveOffDatabase',
    description: 'Moves stored builds out of the database onto node disks: each kept build onto two nodes (checked) before its database files go; builds nothing keeps just lose their files. limit builds per call; dryRun says what it would do.',
    inputSchema: z.object({
        dryRun: z.boolean().optional().describe('Report, move nothing'),
        limit: z.number().int().min(1).max(200).default(20).describe('Builds handled in this call'),
    }),
    outputSchema: moveOffDatabaseOutputSchema,
    rest: { method: 'POST', path: '/artifacts/move-off-database' },
    destructive: true,
    visibility: 'public',
    dependencies: ['serve.artifact', 'serve.part', 'serve.release'],
    filePath: 'src/catalog/tools/moveOffDatabase.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.dryRun ? 'would move' : 'moved'} ${o.moved}, dropped ${o.dropped}, ${o.short.length} short, ${o.left} left (${Math.round(o.bytes / 1e6)} MB freed)${o.short.length > 0 ? `\n${o.short.join('\n')}` : ''}`,
    timeout: 1_800_000,
});

/**
 * The same, every hour, on the leader. Still named pruneDaily (renaming moves its contract key);
 * it ran daily until a day's builds alone filled the database (2026-10-01).
 */
export const artifactPruneDailyContract = defineContract({
    domain: 'serve.artifact',
    action: 'pruneDaily',
    description: 'Runs serve.artifact.prune every ARTIFACT_PRUNE_INTERVAL_MS (default 1 h).',
    inputSchema: z.object({}),
    outputSchema: pruneOutputSchema,
    rest: { method: 'POST', path: '/artifacts/prune-daily' },
    destructive: true,
    leaderScoped: true,
    dependencies: ['serve.artifact', 'serve.part', 'serve.release'],
    filePath: 'src/catalog/tools/pruneArtifacts.ts',
    concurrency: 'interval',
    intervalMs: Number(process.env.ARTIFACT_PRUNE_INTERVAL_MS ?? 3600_000),
    permissions: ['operator'],
    print: (o) => `removed ${o.removed} builds (${Math.round(o.bytes / 1e6)} MB)`,
    timeout: 300_000,
});
