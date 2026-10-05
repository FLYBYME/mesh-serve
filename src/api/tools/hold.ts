import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { AddOutput, HoldInput } from '../contracts/expose.contract.js';

/**
 * serve.expose.hold -- the approved list. The gateway holds every destructive call made with an api
 * token for an operator's decision; an operator may say, for one exposed contract, that such calls
 * run at once. A workspace's daemon reports in with workspace.hello, answer and output: each was
 * held, and a workspace could never become ready (2026-10-05). Only contract rows; an event is
 * never held.
 */
export async function hold(input: HoldInput, ctx: IServiceContext): Promise<AddOutput> {
    // The api may be any tenant's: its row lives in that tenant (as expose.add places it).
    const api = await ctx.call('serve.api.resolveById', { id: input.apiId });
    const meta = { user: { id: ctx.meta?.user?.id ?? '', tenant_id: api.tenantId } };
    const rows = ctx.db('serve.expose', meta);

    const row = await rows.findOne({ query: { apiId: input.apiId, contract: input.contract } });
    if (row === undefined) {
        throw new MeshError({ message: `"${input.contract}" is not exposed on this api.`, code: 'NOT_FOUND', status: 404 });
    }

    if (row.kind === 'event') {
        throw new MeshError({ message: `"${input.contract}" is an event: events are never held.`, code: 'BAD_REQUEST', status: 400 });
    }

    const updated = await rows.update({ id: row.id, unheld: !input.hold });
    const result = updated ?? { ...row, unheld: !input.hold };

    ctx.logger.info(`[api] ${input.contract} on ${input.apiId}: destructive token calls ${input.hold ? 'held again' : 'run at once (approved)'}, by ${ctx.meta?.user?.id ?? 'unknown'}`);

    return result;
}
