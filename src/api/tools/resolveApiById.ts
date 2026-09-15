import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { apiCrud, type ResolveApiByIdInput, type ResolveApiByIdOutput } from '../contracts/api.contract.js';
import type { ApiService } from '../api.service.js';

export async function resolveApiById(
    this: ApiService,
    input: ResolveApiByIdInput,
    ctx: IServiceContext
): Promise<ResolveApiByIdOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(apiCrud.get.outputSchema, 'serve.api');
    const api = await repo.get(input.id);
    if (api === undefined) {
        throw new MeshError({ message: `No api "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    return apiCrud.get.outputSchema.parse(api);
}
