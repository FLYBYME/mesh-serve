import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, z } from '@flybyme/mesh';

import type { artifactPullContract } from '../contracts/artifact.contract.js';
import { artifactIsLocal, pullArtifact } from '../methods/pullArtifact.js';

type Input = z.infer<typeof artifactPullContract.inputSchema>;
type Output = z.infer<typeof artifactPullContract.outputSchema>;

export async function pull(input: Input, ctx: IServiceContext): Promise<Output> {
    const tenantId = ctx.meta?.tenant_id;
    if (typeof tenantId !== 'string' || tenantId === '') {
        throw new MeshError({ message: 'serve.artifact.pull needs the tenant the build belongs to.', code: 'BAD_REQUEST', status: 400 });
    }
    const meta = { tenant_id: tenantId };
    // Every successful build with this hash, newest first: the same content can have been built on
    // more than one node (a rebuild of the same commit), and each is a place to copy it from.
    const builds = await ctx.db('serve.artifact', meta).find({ query: { hash: input.artifactHash, status: 'success' }, sort: '-createdAt' });
    if (builds.length === 0) {
        throw new MeshError({ message: `No successful build with hash ${input.artifactHash}.`, code: 'NOT_FOUND', status: 404 });
    }
    if (await artifactIsLocal(ctx, input.artifactHash, builds[0]!)) return { artifactHash: input.artifactHash, from: 'local' };
    const from = await pullArtifact(ctx, input.artifactHash, builds, meta);
    ctx.logger.info(`[serve.artifact] pulled ${input.artifactHash.slice(0, 12)} from ${from}`);
    return { artifactHash: input.artifactHash, from };
}
