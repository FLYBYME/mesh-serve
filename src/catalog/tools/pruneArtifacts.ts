import { Database, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { artifactCrud, type Artifact } from '../contracts/artifact.contract.js';
import type { PruneArtifactsOutput } from '../contracts/artifact.contract.js';
import { partCrud } from '../contracts/part.contract.js';
import { releaseCrud } from '../contracts/release.contract.js';
import { hashesToDrop, hashesToKeep } from '../methods/artifactRetention.js';
import { dropStoredBuild, storedBuilds } from '../methods/artifactStore.js';

const ServedSchema = z.object({ id: z.string(), releaseHash: z.string().optional() });

/** Every build record of every tenant, and the hashes retention keeps (methods/artifactRetention.ts). */
export async function retention(ctx: IServiceContext): Promise<{ artifacts: Artifact[]; keep: Set<string> }> {
    const db = ctx.broker.getProvider<Database>('database');
    const parts = (await db.repo(partCrud.get.outputSchema, 'serve.part').find({ query: {} })).map((p) => partCrud.get.outputSchema.parse(p));
    const artifacts = (await db.repo(artifactCrud.get.outputSchema, 'serve.artifact').find({ query: {} })).map((a) => artifactCrud.get.outputSchema.parse(a));
    const releases = (await db.repo(releaseCrud.get.outputSchema, 'serve.release').find({ query: {} })).map((r) => releaseCrud.get.outputSchema.parse(r));
    // Only what a site serves, read without the cdn's contract: the cdn depends on the catalog, not
    // the other way round.
    const sites = (await db.repo(ServedSchema, 'serve.cdn').find({ query: {} })).map((s) => ServedSchema.parse(s));

    const keep = hashesToKeep({
        parts: parts.map((p) => ({ ...(p.artifactId !== undefined ? { artifactId: p.artifactId } : {}) })),
        artifacts: artifacts.map((a) => ({ id: a.id, partId: a.partId, status: a.status, updatedAt: a.updatedAt, ...(a.hash !== undefined ? { hash: a.hash } : {}) })),
        releases: releases.map((r) => ({
            compositionId: r.compositionId, createdAt: r.createdAt, ...(r.hash !== undefined ? { hash: r.hash } : {}),
            artifacts: r.artifacts.map((a) => ({ ...(a.hash !== undefined ? { hash: a.hash } : {}) })),
        })),
        served: sites.flatMap((s) => (s.releaseHash !== undefined ? [s.releaseHash] : [])),
        now: new Date(),
    });

    return { artifacts, keep };
}

/**
 * Removes stored build files nothing needs (methods/artifactRetention.ts). Cross-tenant, as
 * watchRelease is: builds of every tenant share the one bucket. `dryRun` reports what would go.
 */
async function pruneStored(ctx: IServiceContext, dryRun: boolean): Promise<PruneArtifactsOutput> {
    const { keep } = await retention(ctx);
    const stored = await storedBuilds(ctx.broker);
    const drop = hashesToDrop(stored.keys(), keep);

    let files = 0;
    let bytes = 0;
    for (const hash of drop) {
        const size = stored.get(hash) ?? { files: 0, bytes: 0 };
        if (!dryRun) await dropStoredBuild(ctx.broker, hash);
        files += size.files;
        bytes += size.bytes;
    }
    ctx.logger?.info(`[catalog] artifact files: ${dryRun ? 'would remove' : 'removed'} ${drop.length} builds (${files} files, ${Math.round(bytes / 1e6)} MB); kept ${stored.size - drop.length}`);
    return { dryRun, kept: stored.size - drop.length, removed: drop.length, files, bytes };
}

export async function prune(params: { dryRun?: boolean }, ctx: IServiceContext): Promise<PruneArtifactsOutput> {
    return pruneStored(ctx, params.dryRun === true);
}

export async function pruneDaily(_params: Record<string, never>, ctx: IServiceContext): Promise<PruneArtifactsOutput> {
    return pruneStored(ctx, false);
}
