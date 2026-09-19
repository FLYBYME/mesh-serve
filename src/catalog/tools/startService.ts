import { pathToFileURL } from 'node:url';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, IServiceModule } from '@flybyme/mesh';

import type { PartStartInput, PartStartOutput } from '../contracts/part.contract.js';
import { artifactAssetPath } from '../methods/artifacts.js';
import { ensureArtifactNodeModules } from '../methods/build.js';
import { getRunningService, markServiceRunning } from '../methods/services.js';

export async function startService(input: PartStartInput, ctx: IServiceContext): Promise<PartStartOutput> {
    const part = await ctx.db('serve.part').resolve({ id: input.id });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind !== 'service') {
        throw new MeshError({ message: `Part "${part.key}" is kind "${part.kind}", not "service".`, code: 'BAD_REQUEST', status: 400 });
    }
    if (getRunningService(part.id) !== undefined) {
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

    // buildService marks @flybyme/mesh external and relies entirely on this symlink to resolve it
    // at runtime (see ensureArtifactNodeModules's own doc comment) -- only ever created during a
    // build, so a part whose artifact was *linked* from an existing cache this run (no build step
    // ran) can reach this import with no symlink in place at all. Re-ensuring it here, not just in
    // buildService, is what makes starting a cached artifact work the same as starting a fresh one.
    await ensureArtifactNodeModules('@flybyme/mesh');

    const absolutePath = artifactAssetPath(artifact.hash, jsAsset.url);
    // pathToFileURL, not the bare path: Node's dynamic import() accepts an absolute path on POSIX
    // by convention rather than by spec, and a Windows-hosted supervisor would refuse it outright.
    const imported = await import(pathToFileURL(absolutePath).href) as { default?: new () => IServiceModule };
    if (imported.default === undefined) {
        throw new MeshError({
            message: `"${part.key}"'s built module has no default export -- boot.js's own rule ("the default export exists because it's constructed") applies here too.`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const instance = new imported.default();
    await ctx.broker.registerModule(instance);
    markServiceRunning(part.id, instance.domain);

    return { domain: instance.domain, nodeID: ctx.nodeID };
}
