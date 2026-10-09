import type { IServiceContext } from '@flybyme/mesh';

import type { MoveOffDatabaseOutput } from '../contracts/artifact.contract.js';
import { dropStoredBuild, storedBuilds } from '../methods/artifactStore.js';
import { ARTIFACT_COPIES, spreadArtifact } from '../methods/spreadArtifact.js';
import { retention } from './pruneArtifacts.js';

/** See `artifactMoveOffDatabaseContract` (contracts/artifact.contract.ts). */
export async function moveOffDatabase(input: { dryRun?: boolean | undefined; limit: number }, ctx: IServiceContext): Promise<MoveOffDatabaseOutput> {
    const dryRun = input.dryRun === true;
    const { artifacts, keep } = await retention(ctx);
    const stored = await storedBuilds(ctx.broker);
    const out: MoveOffDatabaseOutput = { dryRun, moved: 0, dropped: 0, short: [], left: stored.size, bytes: 0 };

    for (const [hash, size] of [...stored].slice(0, input.limit)) {
        if (!keep.has(hash)) {
            if (!dryRun) await dropStoredBuild(ctx.broker, hash);
            out.dropped++;
            out.bytes += size.bytes;
            out.left--;
            continue;
        }

        // The newest successful record of this build: where it was made, and who keeps copies.
        const build = artifacts
            .filter((a) => a.hash === hash && a.status === 'success')
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
        if (build === undefined) {
            out.short.push(`${hash.slice(0, 12)}: kept, but no successful build record names it`);
            continue;
        }
        if (dryRun) {
            out.moved++;
            continue;
        }

        const { holders, failures } = await spreadArtifact(ctx.broker, {
            id: build.id, tenantId: build.tenantId, hash, builtOn: build.builtOn, heldBy: build.heldBy,
        }, { verify: true });
        if (holders.length < ARTIFACT_COPIES) {
            out.short.push(`${hash.slice(0, 12)}: on ${holders.length} of ${ARTIFACT_COPIES} nodes (${holders.join(', ') || 'none'})${failures.length > 0 ? `: ${failures.join('; ')}` : ''}`);
            continue;
        }
        await dropStoredBuild(ctx.broker, hash);
        out.moved++;
        out.bytes += size.bytes;
        out.left--;
    }

    ctx.logger.info(`[serve.artifact] off the database: ${dryRun ? 'would move' : 'moved'} ${out.moved}, dropped ${out.dropped}, ${out.short.length} short, ${out.left} left`);
    return out;
}
