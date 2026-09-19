import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { RemoveInput, RemoveOutput } from '../contracts/expose.contract.js';
import type { ApiService } from '../api.service.js';

export async function remove(
    this: ApiService,
    input: RemoveInput,
    ctx: IServiceContext
): Promise<RemoveOutput> {
    // Same reasoning as add: the target api's tenant isn't known from apiId alone.
    const api = await ctx.call('serve.api.resolveById', { id: input.apiId });
    // Nested under `user`: see add.ts for why a flat `{ tenant_id }` is silently shadowed by the
    // caller's own ambient `user.tenant_id` (ServiceBroker.internalCall's shallow meta merge).
    const meta = { user: { id: ctx.meta?.user?.id ?? '', tenant_id: api.tenantId } };

    const row = await ctx.call('serve.expose.find_one', {
        query: { apiId: input.apiId, contract: input.contract },
    }, { meta });
    if (row === undefined) {
        throw new MeshError({ message: `"${input.contract}" is not exposed on this api.`, code: 'NOT_FOUND', status: 404 });
    }

    await ctx.call('serve.expose.delete', { id: row.id }, { meta });

    ctx.logger.debug(`removed expose "${input.contract}" from api "${input.apiId}"`, {});

    return { removed: true };
}
