import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { RemoveInput, RemoveOutput } from '../contracts/expose.contract.js';
import type { ApiService } from '../api.service.js';

export async function remove(
    this: ApiService,
    input: RemoveInput,
    ctx: IServiceContext
): Promise<RemoveOutput> {
    // Same reasoning as add: the target site's tenant isn't known from siteId alone.
    const site = await ctx.broker.call('serve.cdn.resolveById', { id: input.siteId });
    const meta = { tenant_id: site.tenantId };

    const row = await ctx.broker.call('serve.expose.find_one', {
        query: { siteId: input.siteId, contract: input.contract },
    }, { meta });
    if (row === undefined) {
        throw new MeshError({ message: `"${input.contract}" is not exposed on this site.`, code: 'NOT_FOUND', status: 404 });
    }

    await ctx.broker.call('serve.expose.delete', { id: row.id }, { meta });

    ctx.logger.debug(`removed expose "${input.contract}" from site "${input.siteId}"`, {});

    return { removed: true };
}
