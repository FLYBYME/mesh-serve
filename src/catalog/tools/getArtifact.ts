import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { artifactCrud, type GetArtifactInput, type GetArtifactOutput } from '../contracts/artifact.contract.js';
import type { CatalogService } from '../catalog.service.js';

export async function getArtifact(
    this: CatalogService,
    input: GetArtifactInput,
    ctx: IServiceContext,
): Promise<GetArtifactOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(artifactCrud.get.outputSchema, 'serve.artifact');
    const artifact = await repo.findOne({ hash: input.hash });
    if (artifact === undefined) {
        throw new MeshError({ message: `No artifact for hash "${input.hash}".`, code: 'NOT_FOUND', status: 404 });
    }
    return artifactCrud.get.outputSchema.parse(artifact);
}
