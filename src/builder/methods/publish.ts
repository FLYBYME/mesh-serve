/**
 * One part: bundle it, store its bytes, publish it as an artifact.
 *
 * Split out of `build_start` because a tool should read as the thing it does — fetch a repository,
 * then do this once per part it declares — and because *what happens to one part* is the half worth
 * testing on its own.
 *
 * **A failure here is recorded and does not stop the others.** A site pins each part by version, so
 * publishing one of two is a coherent outcome rather than a half-finished one.
 */

import type { IServiceContext, z } from '@flybyme/mesh';

import type { BuilderService } from '../builder.service.js';
import type { buildStartContract } from '../contracts/artifact.contract.js';
import type { Artifact, Declaration, ResolvedDependency } from '../schema/artifact.js';
import type { SourceRef } from '../schema/build.js';
import { bundlePart } from './bundle.js';
import { artifactDigest, inputHash } from './content.js';

/** Bumped when a change in the builder could change the output. It is part of the cache key. */
export const BUILDER_VERSION = '2';

/**
 * What building one part answers, taken off the contract so it cannot drift from it.
 *
 * `part` and `version` are the caller's own input, so they are added there rather than here.
 */
type PartResult = Omit<z.infer<typeof buildStartContract['outputSchema']>, 'part' | 'version'>;

/**
 * What to build, **already resolved from the catalog**.
 *
 * Not a `DescribedPart` read out of the repository's `mesh.json`. The descriptor seeded the catalog
 * at publish time and the collection is authoritative from then on — so a repository that edits its
 * descriptor cannot change what an already-published version builds, which is the same immutability
 * that makes a version range safe to depend on.
 */
export interface PublishInput {
    readonly part: {
        readonly kind: 'kernel' | 'application' | 'extension';
        readonly id: string;
        readonly version: string;
        /** The source entry, relative to `root`. Part of the input hash. */
        readonly entry: string;
    };
    /** The workspace the fetcher wrote. Owned and destroyed by the caller. */
    readonly root: string;
    readonly source: SourceRef;
    /** The kernel range this version was published against. Absent on a kernel. */
    readonly kernel?: string;
    /** Contract keys this version calls. Already flattened by the catalog. */
    readonly requires: readonly string[];
    readonly requiredParts: readonly { readonly id: string; readonly version: string; readonly optional: boolean }[];
    readonly builtAgainst: readonly ResolvedDependency[];
}

export async function publishPart(
    service: BuilderService,
    { part, root, source, kernel, requires, requiredParts, builtAgainst }: PublishInput,
    ctx: IServiceContext,
): Promise<PartResult> {
    const startedAt = new Date();
    const hash = inputHash({ source, entry: part.entry, builderVersion: BUILDER_VERSION });

    const cached = await cachedArtifact(hash, ctx);
    if (cached !== undefined) {
        ctx.logger.info(`[builder] ${part.id}: cached ${cached.artifactDigest}`);
        return { ...cached, state: 'succeeded', cached: true };
    }

    try {
        const { files, blobs } = await bundlePart(root, part, service.maxBytes);

        // Bytes first. An artifact record naming content this node never stored would be a row
        // pointing at nothing, and every serving node would ask for it forever.
        for (const [digest, content] of blobs) await service.blobs.put(digest, content);

        const declaration: Declaration = {
            part: { kind: part.kind, id: part.id, version: part.version, entry: 'index.js' },
            // A kernel has no kernel. Everything else records the requirement it was written
            // against, which is the only thing standing between a stale part and a browser.
            ...(part.kind === 'kernel' || kernel === undefined ? {} : { kernel }),
            requires: [...requires],
            requiredParts: requiredParts.map((required) => ({ ...required })),
            builtAgainst: [...builtAgainst],
        };

        const artifact: Omit<Artifact, 'buildId'> = {
            digest: artifactDigest(files),
            files: [...files],
            totalSize: files.reduce((sum, file) => sum + file.size, 0),
            builtAt: new Date(),
            declaration,
        };

        const build = await ctx.call('build.create', {
            source, inputHash: hash, state: 'succeeded', startedAt, finishedAt: new Date(),
            artifactDigest: artifact.digest,
        });

        /**
         * **Identical bytes are the same artifact, not a conflict.**
         *
         * Two versions of a part whose sources are byte-identical — a release that only moved a
         * version number, a dependency range widened in `package.json` — bundle to the same output
         * and therefore the same digest. That is content addressing working, and the row already
         * there describes these exact bytes.
         *
         * mesh 2.4.0 put a global unique index on `digest` to close a real hole: two rows claiming
         * the same bytes. Creating unconditionally then turned the *success* case into a failed
         * build — `auth@0.2.0` failed with `Duplicate value "sha256:5037…"` because it is compiled
         * from the same source as `0.1.0`. Reuse the row instead.
         *
         * No event, because nothing was published: the artifact already existed and anything
         * listening has already seen it. The version→digest link is not affected — `build_start`
         * writes that from the digest returned here.
         */
        const existing = await ctx.call('artifact.find_one', { query: { digest: artifact.digest } });

        if (existing === null || existing === undefined) {
            await ctx.call('artifact.create', { ...artifact, buildId: build.id });

            ctx.emit('builder.artifact_published', {
                digest: artifact.digest, partId: part.id, kind: part.kind, version: part.version,
            });
        } else {
            ctx.logger.info(
                `[builder] ${part.id}: ${artifact.digest} already exists — same bytes, reusing it.`,
            );
        }

        ctx.logger.info(
            `[builder] ${part.id}: ${artifact.digest} ` +
            `(${String(files.length)} files, ${String(artifact.totalSize)} bytes)`,
        );

        return {
            buildId: build.id, state: 'succeeded',
            artifactDigest: artifact.digest, cached: false,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`[builder] ${part.id}: failed — ${message}`);

        // The failure is a row, because the workspace it happened in is already gone and a failed
        // build with nothing recorded is a bug report nobody can act on.
        const build = await ctx.call('build.create', {
            source, inputHash: hash, state: 'failed', startedAt, finishedAt: new Date(), error: message,
        });

        return { buildId: build.id, state: 'failed', cached: false };
    }
}

/**
 * Has this exact input been built already, and do we still hold what it produced?
 *
 * Same commit, same entry, same builder: nothing runs, not even a bundle. Two reads rather than an
 * in-process map — a cache in memory would forget everything whenever a builder node was replaced,
 * which is a cache that only ever works in a test.
 *
 * **Both questions are asked**, because a build row outlives the artifact it names if anything ever
 * prunes the store. Answering from the build row alone would return a digest no node can fetch.
 */
async function cachedArtifact(
    hash: string,
    ctx: IServiceContext,
): Promise<{ buildId: string; artifactDigest: string } | undefined> {
    const previous = await ctx.call('build.find_one', {
        query: { inputHash: hash, state: 'succeeded' },
    });
    if (previous === null || previous === undefined) return undefined;

    const digest = previous.artifactDigest;
    if (digest === undefined) return undefined;

    // By query, not by `get`: the digest is the artifact's identity but not its document id, because
    // `defineCrud` mints that and nothing can supply one.
    const artifact = await ctx.call('artifact.find_one', { query: { digest } });
    if (artifact === null || artifact === undefined) return undefined;

    return { buildId: previous.id, artifactDigest: digest };
}
