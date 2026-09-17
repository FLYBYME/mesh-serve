import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { buildDescriptor } from '../methods/descriptor.js';
import type { DescribeInput, DescribeOutput } from '../contracts/api.contract.js';
import type { ApiService } from '../api.service.js';

/**
 * Same shape as handleDescribe's HTTP path (resolveApi -> resolveExposeRows -> buildDescriptor),
 * reachable by ctx.call instead of an HTTP GET, for a peer that isn't itself an HTTP client.
 */
export async function describe(
    this: ApiService,
    input: DescribeInput,
    ctx: IServiceContext,
): Promise<DescribeOutput> {
    const api = await ctx.call('serve.api.resolveByHost', { apiHost: input.host });
    if (api === undefined) {
        throw new MeshError({ message: `No api for host "${input.host}".`, code: 'NOT_FOUND', status: 404 });
    }
    const rows = await ctx.call('serve.expose.find', { query: { apiId: api.id } }, { meta: { tenant_id: api.tenantId } });
    const descriptor = buildDescriptor(api.apiHost, rows);
    return { ...descriptor, calls: descriptor.calls.map((c) => ({ ...c })) };
}
