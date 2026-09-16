import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, IServiceToolRegistry } from '@flybyme/mesh';

import type { HoldDecideInput, HoldDecideOutput } from '../contracts/hold.contract.js';
import type { HoldService } from '../hold.service.js';

/**
 * Replays the frozen call under the account that originally asked for it, not the operator
 * deciding it -- releasing a hold is "yes, this specific call may happen", not "grant the
 * operator's own broader access to it". `row.input` is exactly what the agent sent; nothing here
 * re-derives or re-validates it beyond whatever the replayed contract's own schema does.
 */
export async function decide(
    this: HoldService,
    input: HoldDecideInput,
    ctx: IServiceContext
): Promise<HoldDecideOutput> {
    const row = await ctx.call('serve.hold.resolve', { id: input.holdId });
    if (row === undefined) {
        throw new MeshError({ message: `No held call "${input.holdId}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (row.status !== 'held') {
        throw new MeshError({
            message: `Held call "${input.holdId}" was already ${row.status}.`,
            code: 'CONFLICT', status: 409,
        });
    }

    const decidedBy = ctx.meta?.user?.id ?? '';
    const decidedAt = new Date().toISOString();

    if (!input.approved) {
        await ctx.call('serve.hold.update', {
            id: input.holdId, status: 'rejected', decidedBy, decidedAt, reason: input.reason,
        });
        return { holdId: input.holdId, status: 'rejected' };
    }

    const replayMeta = { user: { id: row.requestedBy.userId, tenant_id: row.tenantId } };

    try {
        const result: unknown = await ctx.call(
            row.call as keyof IServiceToolRegistry,
            row.input as never,
            { meta: replayMeta },
        );
        await ctx.call('serve.hold.update', {
            id: input.holdId, status: 'released', decidedBy, decidedAt, reason: input.reason, result,
        });
        return { holdId: input.holdId, status: 'released', result };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.call('serve.hold.update', {
            id: input.holdId, status: 'released', decidedBy, decidedAt, reason: input.reason, error: message,
        });
        return { holdId: input.holdId, status: 'released', error: message };
    }
}
