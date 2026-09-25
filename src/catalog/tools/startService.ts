import fs from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { Part, PartStartInput, PartStartOutput } from '../contracts/part.contract.js';
import { artifactAssetPath } from '../methods/artifacts.js';
import { artifactToRun, type RunnableArtifact } from '../methods/partArtifact.js';
import { ensureArtifactNodeModules } from '../methods/build.js';
import { getRunningService, markServiceRunning } from '../methods/services.js';
import { loadAndRegisterModule } from '../methods/loadModule.js';
import { runOnStart } from '../methods/onStart.js';

export async function startService(input: PartStartInput, ctx: IServiceContext): Promise<PartStartOutput> {
    const part = await ctx.db('serve.part').resolve({ id: input.id });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind !== 'service') {
        throw new MeshError({ message: `Part "${part.key}" is kind "${part.kind}", not "service".`, code: 'BAD_REQUEST', status: 400 });
    }
    if (getRunningService(ctx.nodeID, part.id) !== undefined) {
        throw new MeshError({ message: `"${part.key}" is already running on this node.`, code: 'BAD_REQUEST', status: 400 });
    }

    // Told as it happens -- started, or failed and why -- so starting a part can be watched over the
    // api instead of read out of the node's journal.
    const lifecycle = { tenantId: part.tenantId, partId: part.id, key: part.key, nodeID: ctx.nodeID };
    let artifactId: string | undefined;
    try {
        const started = await loadPart(ctx, part, (id) => { artifactId = id; });
        ctx.emit('serve.part.started', { ...lifecycle, ...(artifactId !== undefined ? { artifactId } : {}) });
        return started;
    } catch (err) {
        ctx.emit('serve.part.failed', {
            ...lifecycle,
            ...(artifactId !== undefined ? { artifactId } : {}),
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}

async function loadPart(
    ctx: IServiceContext,
    part: Part,
    onArtifact: (artifactId: string) => void,
): Promise<PartStartOutput> {
    const meta = { tenant_id: part.tenantId };
    const runnable = await artifactToRun(ctx, part, meta);
    const { artifact, hash } = runnable;
    onArtifact(artifact.id);

    const jsAsset = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.js');
    if (jsAsset === undefined) {
        throw new MeshError({ message: `Artifact ${hash} for "${part.key}" has no .js entry.`, code: 'NOT_FOUND', status: 404 });
    }

    await ensureArtifactPresent(ctx, runnable, jsAsset.url, meta);

    // buildService marks @flybyme/mesh external and relies entirely on this symlink to resolve it
    // at runtime (see ensureArtifactNodeModules's own doc comment) -- only ever created during a
    // build, so a part whose artifact was *linked* from an existing cache this run (no build step
    // ran) can reach this import with no symlink in place at all. Re-ensuring it here, not just in
    // buildService, is what makes starting a cached artifact work the same as starting a fresh one.
    await ensureArtifactNodeModules('@flybyme/mesh');

    const absolutePath = artifactAssetPath(hash, jsAsset.url, ctx.nodeID);
    const { domain, nodeID } = await loadAndRegisterModule(ctx, absolutePath);
    markServiceRunning(ctx.nodeID, part.id, domain, absolutePath, artifact.id);

    // After it is marked running, not before: runOnStart's failure path unloads the part and clears
    // exactly that mark, so the mark has to exist for the cleanup to undo.
    await runOnStart(ctx, part, absolutePath, meta);

    return { domain, nodeID };
}

/**
 * `~/.mesh/artifacts` is plain node-local disk, written only by whichever node ran the build
 * (`buildArtifact.ts`, dispatched off the serve.queue leader -- a single node). Placement --
 * automatic (`placementFor`) or pinned (`nodeSelector`) -- routinely picks a *different* node to
 * actually run the part, so this has to close that gap before `loadAndRegisterModule` ever tries
 * to import a path that was never written here.
 *
 * `jsAssetUrl` alone is checked for local presence -- cheap, and it's the one file that has to
 * exist for the import below to succeed at all -- but every asset in `artifact.assets` is fetched
 * and written back, not just that one, so a node that pulls an artifact ends up with the same
 * complete local copy a real build would have produced (source maps included).
 */
async function ensureArtifactPresent(
    ctx: IServiceContext,
    { artifact, hash }: RunnableArtifact,
    jsAssetUrl: string,
    meta: Record<string, unknown>,
): Promise<void> {
    const localPath = artifactAssetPath(hash, jsAssetUrl, ctx.nodeID);
    const alreadyLocal = await fs.access(localPath).then(() => true, () => false);
    if (alreadyLocal) return;

    if (artifact.builtOn === undefined || artifact.builtOn === ctx.nodeID) {
        // Missing, and either nobody recorded having built it (an artifact from before this field
        // existed) or the node that supposedly did is this one -- fetching from ctx.nodeID would
        // just fail the same way again. Only a rebuild can fix either case.
        throw new MeshError({
            message: `Artifact ${hash} has no local copy on this node and no other node is recorded as having built it. Rebuild with serve.artifact.requestBuild.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }

    for (const asset of artifact.assets ?? []) {
        const { contentBase64 } = await ctx.call('serve.artifact.fetchAssetBytes', {
            artifactHash: hash,
            path: asset.url,
        }, { nodeID: artifact.builtOn, meta });

        const destination = artifactAssetPath(hash, asset.url, ctx.nodeID);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, Buffer.from(contentBase64, 'base64'));
    }
}
