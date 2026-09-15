import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { apiCrud, type ResolveApiByHostInput, type ResolveApiByHostOutput } from '../contracts/api.contract.js';
import type { ApiService } from '../api.service.js';

export async function resolveApiByHost(
    this: ApiService,
    input: ResolveApiByHostInput,
    ctx: IServiceContext
): Promise<ResolveApiByHostOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(apiCrud.get.outputSchema, 'serve.api');
    const api = await repo.findOne({ apiHost: input.apiHost });
    if (api === undefined) {
        throw new MeshError({ message: `No api for host "${input.apiHost}".`, code: 'NOT_FOUND', status: 404 });
    }
    return apiCrud.get.outputSchema.parse(api);
}
