import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { BuildInput, BuildOutput } from '../contracts/artifact.contract.js';
import type { CatalogService } from '../catalog.service.js';

/**
 * The dispatch target serve.queue actually calls. buildArtifact (private on CatalogService)
 * already swallows its own failures into an artifact-status update rather than throwing -- that's
 * right for watchRelease's old inline loop (one artifact's failure shouldn't stop the next), but
 * it would make every build look like a "completed" queue job even when the build failed. Re-check
 * the artifact's own final status and throw if it didn't succeed, so serve.queue's own row is an
 * honest record of whether the dispatch actually worked.
 */
export async function build(
    this: CatalogService,
    input: BuildInput,
    ctx: IServiceContext,
): Promise<BuildOutput> {
    const artifact = await ctx.call('serve.artifact.resolve', { id: input.id });
    if (artifact === undefined) {
        throw new MeshError({ message: `No artifact "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }

    const part = await ctx.call('serve.part.resolve', { id: artifact.partId });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${artifact.partId}".`, code: 'NOT_FOUND', status: 404 });
    }

    const start = Date.now();
    await this.buildArtifact(artifact);
    const duration = Date.now() - start;


    const after = await ctx.call('serve.artifact.resolve', { id: input.id });
    if (after?.status === 'failed') {
        throw new MeshError({ message: after.error ?? 'Build failed.', code: 'BUILD_FAILED', status: 500 });
    }

    return { success: true, duration, hash: after?.hash };
}
