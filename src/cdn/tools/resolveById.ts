import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { siteCrud, type ResolveByIdInput, type ResolveByIdOutput } from '../contracts/site.contract.js';

export async function resolveById(
    input: ResolveByIdInput,
    ctx: IServiceContext
): Promise<ResolveByIdOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(siteCrud.get.outputSchema, 'serve.cdn');
    const site = await repo.get(input.id);
    if (site === undefined) {
        throw new MeshError({ message: `No site "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    return siteCrud.get.outputSchema.parse(site);
}
