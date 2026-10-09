import fs from 'node:fs/promises';
import path from 'node:path';

import type { IServiceContext } from '@flybyme/mesh';

import type { PruneDiskOutput } from '../contracts/artifact.contract.js';
import { ARTIFACT_HASH, artifactsRoot } from '../methods/artifacts.js';
import { KEEP_RECENT_MS } from '../methods/artifactRetention.js';
import { retention } from './pruneArtifacts.js';

async function sizeOf(dir: string): Promise<number> {
    let bytes = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        bytes += entry.isDirectory() ? await sizeOf(full) : (await fs.stat(full)).size;
    }
    return bytes;
}

/** See `artifactPruneDiskContract` (contracts/artifact.contract.ts). */
async function pruneThisDisk(ctx: IServiceContext, dryRun: boolean): Promise<PruneDiskOutput> {
    const root = artifactsRoot(ctx.nodeID);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const { artifacts, keep } = await retention(ctx);
    const now = Date.now();
    const out: PruneDiskOutput = { nodeID: ctx.nodeID, dryRun, kept: 0, removed: 0, bytes: 0 };

    // Nothing kept at all means the records were not read, not that every build is unwanted: a
    // platform with parts always pins something. Never wipe a disk on that.
    if (keep.size === 0) {
        if (entries.length > 0) ctx.logger.warn('[serve.artifact] disk: retention keeps nothing -- not pruning');
        return out;
    }

    for (const entry of entries) {
        // Only build folders: a staging or pulling name has a dot in it, and anything else is not ours.
        if (!entry.isDirectory() || !ARTIFACT_HASH.test(entry.name)) continue;
        const folder = path.join(root, entry.name);
        const recent = now - (await fs.stat(folder)).mtimeMs < KEEP_RECENT_MS;
        if (keep.has(entry.name) || recent) {
            out.kept++;
            continue;
        }

        out.bytes += await sizeOf(folder);
        out.removed++;
        if (dryRun) continue;
        await fs.rm(folder, { recursive: true, force: true });

        // No longer a holder: a pull would ask this node first and find nothing.
        for (const build of artifacts.filter((a) => a.hash === entry.name && (a.heldBy ?? []).includes(ctx.nodeID))) {
            await ctx.call('serve.artifact.update', { id: build.id, heldBy: (build.heldBy ?? []).filter((n) => n !== ctx.nodeID) }, { meta: { tenant_id: build.tenantId } });
        }
    }

    if (out.removed > 0) ctx.logger.info(`[serve.artifact] disk: ${dryRun ? 'would remove' : 'removed'} ${out.removed} builds (${Math.round(out.bytes / 1e6)} MB), kept ${out.kept}`);
    return out;
}

export async function pruneDisk(params: { dryRun?: boolean | undefined }, ctx: IServiceContext): Promise<PruneDiskOutput> {
    return pruneThisDisk(ctx, params.dryRun === true);
}

export async function pruneDiskHourly(_params: Record<string, never>, ctx: IServiceContext): Promise<PruneDiskOutput> {
    return pruneThisDisk(ctx, false);
}
