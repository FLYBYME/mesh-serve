import type { IServiceContext } from '@flybyme/mesh';

import type { GenerateClientInput, GenerateClientOutput } from '../contracts/generateClient.contract.js';
import { generateClient as render } from '../methods/generateClient.js';

/**
 * The server-side half of "generate a browser-safe client": the caller (mesh-serve's own CLI, run
 * locally or as part of a cdn build) already knows *which* api it wants a client for -- what it
 * cannot safely do itself is render the shapes, since that means importing mesh-serve's own zod,
 * exactly the cross-package reference this whole design exists to avoid. So the rendering happens
 * here, against mesh-serve's own zod, and the caller gets back finished text.
 */
export async function generateClient(
    input: GenerateClientInput,
    ctx: IServiceContext,
): Promise<GenerateClientOutput> {
    const api = await ctx.call('serve.api.resolveById', { id: input.apiId });
    const meta = { tenant_id: api.tenantId };
    const allRows = await ctx.db('serve.expose', meta).find({ query: { apiId: input.apiId } });

    // A wanted-but-unexposed contract is silently dropped, same as buildDescriptor already does for
    // a stale row -- the caller asked for what it calls, not for a guarantee everything it calls is
    // actually reachable; that mismatch is a deploy-time problem, not a codegen-time one.
    const rows = input.contracts === undefined
        ? allRows
        : allRows.filter((row) => input.contracts?.includes(row.contract) === true);

    return { source: await render(api.apiHost, api.apiHost, rows) };
}
