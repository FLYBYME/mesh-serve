import fs from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { artifactAssetPath } from './artifacts.js';
import { restoreArtifact } from './artifactStore.js';

/** What pulling needs to know of one build record: who built it, and which files it has. */
export interface PullSource {
    readonly builtOn?: string | undefined;
    readonly assets?: ReadonlyArray<{ readonly url: string; readonly integrity?: string | undefined }> | undefined;
    /** What a rebuild needs: the part, the exact commit it was built from, and a kernel's drivers. */
    readonly partId?: string | undefined;
    readonly commit?: string | undefined;
    readonly drivers?: readonly string[] | undefined;
}

/** How long a pull waits for a rebuild of a build nothing else can give (a build takes 5-60 s). */
const REBUILD_WAIT_MS = 5 * 60 * 1000;

/** What `pullArtifact` returns when the build came from the database, not from a node. */
export const FROM_DATABASE = 'database';

/** One pull per build at a time: a page asks for many files of the same build at once. */
const inFlight = new Map<string, Promise<string>>();

/**
 * Copies a build this node does not have onto its own disk, from a node that does.
 *
 * `~/.mesh/artifacts` is node-local; a build lands only on the node that ran it. Every reader on
 * another node -- a part starting there (`startService.ts`), the website serving its files
 * (`serve.artifact.pull`, `cdn/gateway.ts`) -- closes that gap here. `sources` are the build
 * records with this hash, newest first; each node that built one is tried in turn, so a rebuild on
 * another node is a second place to get it from. Every file is written to a temporary name and
 * renamed into place: a reader never sees half a file. Returns the node it came from.
 */
export async function pullArtifact(
    ctx: IServiceContext,
    hash: string,
    sources: readonly PullSource[],
    meta: Record<string, unknown>,
): Promise<string> {
    const running = inFlight.get(hash);
    if (running !== undefined) return running;
    const pull = pullFromAny(ctx, hash, sources, meta).finally(() => inFlight.delete(hash));
    inFlight.set(hash, pull);
    return pull;
}

async function pullFromAny(ctx: IServiceContext, hash: string, sources: readonly PullSource[], meta: Record<string, unknown>): Promise<string> {
    const tried = new Set<string>();
    const failures: string[] = [];
    for (const source of sources) {
        const from = source.builtOn;
        if (from === undefined || from === ctx.nodeID || tried.has(from)) continue;
        tried.add(from);
        // A builder that has left the mesh is skipped, not called: the call would only time out,
        // and a website visitor would wait for it.
        if (ctx.broker.registry.getNode(from)?.available !== true) {
            failures.push(`${from}: not in the mesh`);
            continue;
        }
        try {
            for (const asset of source.assets ?? []) {
                const { contentBase64 } = await ctx.call('serve.artifact.fetchAssetBytes', { artifactHash: hash, path: asset.url }, { nodeID: from, meta });
                const destination = artifactAssetPath(hash, asset.url, ctx.nodeID);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                const temporary = `${destination}.${process.pid}.pulling`;
                await fs.writeFile(temporary, Buffer.from(contentBase64, 'base64'));
                await fs.rename(temporary, destination);
            }
            return from;
        } catch (err) {
            failures.push(`${from}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // No node could give it: the copy every build keeps in the database (methods/artifactStore.ts),
    // checked against the record's integrity file by file.
    const withAssets = sources.find((s) => (s.assets ?? []).length > 0);
    if (withAssets?.assets !== undefined) {
        try {
            await restoreArtifact(ctx.broker, hash, withAssets.assets, ctx.nodeID);
            return FROM_DATABASE;
        } catch (err) {
            failures.push(`database: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Last: build it again, from the exact commit it was built from (owner, 2026-09-28: "both" --
    // the database copy and a rebuild). Accepted only if it comes out byte for byte the same: a
    // release names its builds by hash, so a different build under the old name would be wrong.
    const buildable = sources.find((s) => s.partId !== undefined && s.commit !== undefined);
    if (buildable?.partId !== undefined && buildable.commit !== undefined) {
        try {
            const rebuilt = await rebuild(ctx, hash, buildable.partId, buildable.commit, buildable.drivers, meta);
            ctx.logger.warn(`[serve.artifact] ${hash.slice(0, 12)} was lost everywhere and rebuilt from ${buildable.commit.slice(0, 7)} on ${rebuilt.builtOn ?? '?'}`);
            // Only where it is and its files: no part/commit, so this cannot rebuild again.
            return await pullFromAny(ctx, hash, [{ builtOn: rebuilt.builtOn, assets: rebuilt.assets }], meta);
        } catch (err) {
            failures.push(`rebuild: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const where = tried.size === 0
        ? `has no local copy on this node and no other node is recorded as having built it`
        : `could not be copied here from any node that built it`;
    throw new MeshError({
        message: `Artifact ${hash} ${where}${failures.length > 0 ? ` (${failures.join('; ')})` : ''}. Rebuild with serve.artifact.requestBuild.`,
        code: 'NOT_FOUND',
        status: 404,
    });
}

/**
 * Asks the builder for the same part at the same commit (and drivers), waits for it, and returns
 * the new build's record -- only if its hash is the lost one's. Needs a node running the build queue.
 */
async function rebuild(
    ctx: IServiceContext,
    hash: string,
    partId: string,
    commit: string,
    drivers: readonly string[] | undefined,
    meta: Record<string, unknown>,
): Promise<PullSource> {
    const requested = await ctx.call('serve.artifact.requestBuild', {
        partId, ref: commit, ...(drivers !== undefined && drivers.length > 0 ? { drivers: [...drivers] } : {}),
    }, { meta });
    const deadline = Date.now() + REBUILD_WAIT_MS;
    for (;;) {
        const build = await ctx.call('serve.artifact.get', { id: requested.id }, { meta });
        if (build.status === 'failed') throw new Error(`the rebuild failed: ${build.error ?? 'no reason given'}`);
        if (build.status === 'success') {
            if (build.hash !== hash) {
                throw new Error(`rebuilding ${commit.slice(0, 7)} produced ${build.hash ?? '?'}, not ${hash}: this build is not reproducible`);
            }
            return build;
        }
        if (Date.now() > deadline) throw new Error(`no builder finished the rebuild within ${REBUILD_WAIT_MS / 1000} s (is a node running the build queue?)`);
        await new Promise((r) => setTimeout(r, 2000));
    }
}

/** Whether every file of a build is on this node's disk already. */
export async function artifactIsLocal(ctx: IServiceContext, hash: string, source: PullSource): Promise<boolean> {
    const assets = source.assets ?? [];
    if (assets.length === 0) return false;
    for (const asset of assets) {
        const present = await fs.access(artifactAssetPath(hash, asset.url, ctx.nodeID)).then(() => true, () => false);
        if (!present) return false;
    }
    return true;
}
