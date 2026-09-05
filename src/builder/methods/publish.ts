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
import { requirementsOf, type DescribedPart } from '../schema/descriptor.js';
import { bundlePart } from './bundle.js';
import { artifactDigest, inputHash } from './content.js';

/** Bumped when a change in the builder could change the output. It is part of the cache key. */
export const BUILDER_VERSION = '2';

/** One entry of what `build_start` returns, taken off the contract so it cannot drift from it. */
type PartResult = z.infer<typeof buildStartContract['outputSchema']>['builds'][number];

export interface PublishInput {
    readonly part: DescribedPart;
    /** The workspace the fetcher wrote. Owned and destroyed by the caller. */
    readonly root: string;
    readonly source: SourceRef;
    /** The repository's kernel requirement, copied onto each part's declaration. */
    readonly kernel: string | undefined;
    readonly builtAgainst: readonly ResolvedDependency[];
}

export async function publishPart(
    service: BuilderService,
    { part, root, source, kernel, builtAgainst }: PublishInput,
    ctx: IServiceContext,
): Promise<PartResult> {
    const startedAt = new Date();
    const hash = inputHash({ source, entry: part.entry, builderVersion: BUILDER_VERSION });

    const cached = await cachedArtifact(hash, ctx);
    if (cached !== undefined) {
        ctx.logger.info(`[builder] ${part.id}: cached ${cached.artifactDigest}`);
        return { partId: part.id, ...cached, state: 'succeeded', cached: true };
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
            requires: [...requirementsOf(part)],
            requiredParts: part.requiredParts.map((required) => ({ ...required })),
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

        await ctx.call('artifact.create', { ...artifact, buildId: build.id });

        ctx.emit('builder.artifact_published', {
            digest: artifact.digest, partId: part.id, kind: part.kind, version: part.version,
        });

        ctx.logger.info(
            `[builder] ${part.id}: ${artifact.digest} ` +
            `(${String(files.length)} files, ${String(artifact.totalSize)} bytes)`,
        );

        return {
            partId: part.id, buildId: build.id, state: 'succeeded',
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

        return { partId: part.id, buildId: build.id, state: 'failed', cached: false };
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
