import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { releaseCrud, type GetReleaseInput, type GetReleaseOutput } from '../contracts/release.contract.js';
import type { CatalogService } from '../catalog.service.js';

export async function getRelease(
    this: CatalogService,
    input: GetReleaseInput,
    ctx: IServiceContext,
): Promise<GetReleaseOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(releaseCrud.outputSchema, 'serve.release');
    const release = await repo.findOne({ hash: input.hash });
    if (release === undefined) {
        throw new MeshError({ message: `No release for hash "${input.hash}".`, code: 'NOT_FOUND', status: 404 });
    }
    return release;
}
