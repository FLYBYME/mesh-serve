import fs from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { PartStartInput, PartStartOutput } from '../contracts/part.contract.js';
import type { Artifact } from '../contracts/artifact.contract.js';
import { artifactAssetPath } from '../methods/artifacts.js';
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

    const meta = { tenant_id: part.tenantId };
    // Same "latest successful artifact" query compose.ts's own latestArtifact already uses.
    const artifacts = await ctx.db('serve.artifact', meta).find({
        query: { partId: part.id, status: 'success' },
        sort: '-createdAt',
    });
    const artifact = artifacts[0];
    if (artifact === undefined || artifact.hash === undefined) {
        throw new MeshError({
            message: `No successful build for "${part.key}". Build it first with serve.artifact.requestBuild.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }

    const jsAsset = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.js');
    if (jsAsset === undefined) {
        throw new MeshError({ message: `Artifact ${artifact.hash} for "${part.key}" has no .js entry.`, code: 'NOT_FOUND', status: 404 });
    }

    await ensureArtifactPresent(ctx, artifact as Artifact & { hash: string }, jsAsset.url, meta);

    // buildService marks @flybyme/mesh external and relies entirely on this symlink to resolve it
    // at runtime (see ensureArtifactNodeModules's own doc comment) -- only ever created during a
    // build, so a part whose artifact was *linked* from an existing cache this run (no build step
    // ran) can reach this import with no symlink in place at all. Re-ensuring it here, not just in
    // buildService, is what makes starting a cached artifact work the same as starting a fresh one.
    await ensureArtifactNodeModules('@flybyme/mesh');

    const absolutePath = artifactAssetPath(artifact.hash, jsAsset.url, ctx.nodeID);
    const { domain, nodeID } = await loadAndRegisterModule(ctx, absolutePath);
    markServiceRunning(ctx.nodeID, part.id, domain, absolutePath);

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
    artifact: Artifact & { hash: string },
    jsAssetUrl: string,
    meta: Record<string, unknown>,
): Promise<void> {
    const localPath = artifactAssetPath(artifact.hash, jsAssetUrl, ctx.nodeID);
    const alreadyLocal = await fs.access(localPath).then(() => true, () => false);
    if (alreadyLocal) return;

    if (artifact.builtOn === undefined || artifact.builtOn === ctx.nodeID) {
        // Missing, and either nobody recorded having built it (an artifact from before this field
        // existed) or the node that supposedly did is this one -- fetching from ctx.nodeID would
        // just fail the same way again. Only a rebuild can fix either case.
        throw new MeshError({
            message: `Artifact ${artifact.hash} has no local copy on this node and no other node is recorded as having built it. Rebuild with serve.artifact.requestBuild.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }

    for (const asset of artifact.assets ?? []) {
        const { contentBase64 } = await ctx.call('serve.artifact.fetchAssetBytes', {
            artifactHash: artifact.hash,
            path: asset.url,
        }, { nodeID: artifact.builtOn, meta });

        const destination = artifactAssetPath(artifact.hash, asset.url, ctx.nodeID);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, Buffer.from(contentBase64, 'base64'));
    }
}
