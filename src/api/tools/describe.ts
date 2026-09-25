import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { buildDescriptor } from '../methods/descriptor.js';
import type { DescribeInput, DescribeOutput } from '../contracts/api.contract.js';
import type { Expose } from '../contracts/expose.contract.js';

const EXPOSE_PAGE = 500;

/**
 * Same shape as handleDescribe's HTTP path (resolveApi -> resolveExposeRows -> buildDescriptor),
 * reachable by ctx.call instead of an HTTP GET, for a peer that isn't itself an HTTP client.
 */
export async function describe(
    input: DescribeInput,
    ctx: IServiceContext,
): Promise<DescribeOutput> {
    const api = await ctx.call('serve.api.resolveByHost', { apiHost: input.host });
    if (api === undefined) {
        throw new MeshError({ message: `No api for host "${input.host}".`, code: 'NOT_FOUND', status: 404 });
    }
    // Every row, page by page -- `find` stops at 100 unless told otherwise (see gateway.ts).
    const rows: Expose[] = [];
    for (let offset = 0; ; offset += EXPOSE_PAGE) {
        const page = await ctx.db('serve.expose', { tenant_id: api.tenantId }).find({ query: { apiId: api.id }, limit: EXPOSE_PAGE, offset });
        rows.push(...page);
        if (page.length < EXPOSE_PAGE) break;
    }
    const descriptor = buildDescriptor(api.apiHost, rows, (key) => ctx.broker.contractDeclaration(key));
    return { ...descriptor, calls: descriptor.calls.map((c) => ({ ...c })) };
}
