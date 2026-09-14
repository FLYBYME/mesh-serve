import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { siteCrud, type ResolveApiHostInput, type ResolveApiHostOutput } from '../contracts/site.contract.js';
import type { CdnService } from '../cdn.service.js';

export async function resolveApiHost(
    this: CdnService,
    input: ResolveApiHostInput,
    ctx: IServiceContext
): Promise<ResolveApiHostOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(siteCrud.get.outputSchema, 'serve.cdn');
    const site = await repo.findOne({ apiHost: input.apiHost });
    if (site === undefined) {
        throw new MeshError({ message: `No site for api host "${input.apiHost}".`, code: 'NOT_FOUND', status: 404 });
    }
    return siteCrud.get.outputSchema.parse(site);
}
