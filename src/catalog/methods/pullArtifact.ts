import fs from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { artifactAssetPath } from './artifacts.js';

/** What pulling needs to know of one build record: who built it, and which files it has. */
export interface PullSource {
    readonly builtOn?: string | undefined;
    readonly assets?: ReadonlyArray<{ readonly url: string }> | undefined;
}

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
    throw new MeshError({
        message: tried.size === 0
            ? `Artifact ${hash} has no local copy on this node and no other node is recorded as having built it. Rebuild with serve.artifact.requestBuild.`
            : `Artifact ${hash} could not be copied here from any node that built it (${failures.join('; ')}).`,
        code: 'NOT_FOUND',
        status: 404,
    });
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
