import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { siteCrud, type ResolveHostInput, type ResolveHostOutput } from '../contracts/site.contract.js';
import type { CdnService } from '../cdn.service.js';

export async function resolveHost(
    this: CdnService,
    input: ResolveHostInput,
    ctx: IServiceContext
): Promise<ResolveHostOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(siteCrud.get.outputSchema, 'serve.cdn');
    const site = await repo.findOne({ host: input.host });
    if (site === undefined) {
        throw new MeshError({ message: `No site for "${input.host}".`, code: 'NOT_FOUND', status: 404 });
    }
    return siteCrud.get.outputSchema.parse(site);
}
