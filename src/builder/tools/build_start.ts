/**
 * `builder.build_start` — fetch a commit, bundle every part it declares, publish each as an artifact.
 *
 * ```
 * SourceRef  →  a workspace this builder owns  →  bytes  →  one content-addressed artifact per part
 * ```
 *
 * Nothing outside ever gets a path. The workspace is created, used and destroyed inside this
 * function, and the only thing that leaves is content plus a digest — which is what makes *"the code
 * need not be local to the server"* true rather than aspirational.
 *
 * **Records are written through CRUD, never around it.** This tool has a side effect and an
 * invariant, which is exactly why it is an explicit contract rather than a hook — but the rows it
 * produces go out through `artifact.create` and `build.create` like any other write, so nothing
 * here is a second path into a collection.
 */

import { z, type IServiceContext } from '@flybyme/mesh';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuilderService } from '../builder.service.js';
import { buildStartContract } from '../contracts/artifact.contract.js';
import { bundlePart } from '../methods/bundle.js';
import { artifactDigest, inputHash } from '../methods/content.js';
import { dependenciesFrom } from '../methods/lockfile.js';
import { describeSource, resolveSource } from '../methods/source.js';
import type { Artifact, Declaration, ResolvedDependency } from '../schema/artifact.js';
import type { SourceRef } from '../schema/build.js';
import {
    DESCRIPTOR_FILE, parseDescriptor, requirementsOf, type DescribedPart,
} from '../schema/descriptor.js';

/** Bumped when a change in this builder could change the output. It is part of the cache key. */
export const BUILDER_VERSION = '2';

type Input = z.infer<typeof buildStartContract['inputSchema']>;
type Output = z.infer<typeof buildStartContract['outputSchema']>;

export async function builder_build_start(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    // Before anything else, and before a build record could exist holding it: a branch hashes to
    // itself forever while the code underneath it moves, so a cache keyed on one would serve a stale
    // artifact indefinitely — a deploy that silently does nothing, found days later.
    const source = await resolveSource(input.source);

    // Ours, and destroyed in the `finally`. A caller never learns where it was.
    const workspace = await mkdtemp(join(tmpdir(), 'mesh-build-'));

    try {
        ctx.logger.info(`[builder] fetching ${describeSource(source)}`);
        await this.fetch(source, workspace);

        const root = source.kind === 'git' && source.subdirectory !== undefined
            ? join(workspace, source.subdirectory)
            : workspace;

        const descriptor = parseDescriptor(await readFile(join(root, DESCRIPTOR_FILE), 'utf8'));

        // Read once for the whole repository: one lockfile at the root, even with workspaces. It is
        // committed, so it is here with nothing installed and nothing to run.
        const builtAgainst = dependenciesFrom(
            await readFile(join(root, 'package-lock.json'), 'utf8').catch(() => undefined),
        );

        const builds: Output['builds'] = [];
        for (const part of descriptor.parts) {
            builds.push(await buildOne.call(this, {
                part, root, source, kernel: descriptor.kernel, builtAgainst,
            }, ctx));
        }

        return { builds };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------- one part

interface PartInput {
    readonly part: DescribedPart;
    readonly root: string;
    readonly source: SourceRef;
    /** The repository's kernel requirement, copied onto each part's declaration. */
    readonly kernel: string | undefined;
    readonly builtAgainst: readonly ResolvedDependency[];
}

/**
 * One part, one artifact.
 *
 * A failure here is recorded and does not stop the others: a site pins each part by version, so
 * publishing one of two is a coherent outcome rather than a half-finished one.
 */
async function buildOne(
    this: BuilderService,
    { part, root, source, kernel, builtAgainst }: PartInput,
    ctx: IServiceContext,
): Promise<Output['builds'][number]> {
    const startedAt = new Date();
    const hash = inputHash({ source, entry: part.entry, builderVersion: BUILDER_VERSION });

    // Same commit, same entry, same builder: nothing runs, not even a bundle. Two CRUD reads rather
    // than an in-process Map — a cache that lived in memory would forget everything whenever a
    // builder node was replaced, which is a cache that works only in a test.
    const previous = await ctx.call('build.find', {
        query: { inputHash: hash, state: 'succeeded' }, limit: 1,
    });
    const held = previous[0]?.artifactDigest;
    if (held !== undefined) {
        // By query, not by id. The digest is the artifact's real identity but not its document id —
        // `defineCrud` mints that — so "do we still hold this content" is a find, not a get. Asked
        // rather than assumed, because a build row outlives the artifact it names if anything ever
        // prunes the store, and returning a digest nothing holds would be a deploy pointing at
        // bytes no node can fetch.
        const artifact = await ctx.call('artifact.find_one', { query: { digest: held } });
        if (artifact !== null && artifact !== undefined) {
            ctx.logger.info(`[builder] ${part.id}: cached ${held}`);
            return { partId: part.id, buildId: previous[0]!.id, state: 'succeeded', artifactDigest: held, cached: true };
        }
    }

    try {
        const { files, blobs } = await bundlePart(root, part, this.maxBytes);

        // Bytes first. An artifact record naming content this node never stored would be a row
        // pointing at nothing, and every serving node would ask for it forever.
        for (const [digest, content] of blobs) await this.blobs.put(digest, content);

        const declaration: Declaration = {
            part: { kind: part.kind, id: part.id, version: part.version, entry: 'index.js' },
            // A kernel has no kernel. Everything else records the requirement it was written
            // against, which is the only thing standing between a stale part and a browser.
            ...(part.kind === 'kernel' || kernel === undefined ? {} : { kernel }),
            requires: [...requirementsOf(part)],
            builtAgainst: [...builtAgainst],
        };

        const artifact: Artifact = {
            digest: artifactDigest(files),
            files: [...files],
            totalSize: files.reduce((sum, file) => sum + file.size, 0),
            builtAt: new Date(),
            buildId: '',
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

        return { partId: part.id, buildId: build.id, state: 'succeeded', artifactDigest: artifact.digest, cached: false };
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
