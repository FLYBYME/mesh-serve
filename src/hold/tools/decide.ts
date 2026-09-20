import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, IServiceToolRegistry } from '@flybyme/mesh';

import type { HoldDecideInput, HoldDecideOutput } from '../contracts/hold.contract.js';

/**
 * `holdDecideContract` declares `leaderScoped: true`, so this only ever runs on serve.hold's
 * leader node -- but that alone doesn't stop two overlapping decide calls for the *same* hold
 * (a double-click, a retried request) from both reading `status: 'held'` before either writes,
 * and both replaying the frozen call. `withLock`, keyed per holdId, closes that: only one decide
 * for a given hold runs at a time on that node.
 *
 * Replays the frozen call under the account that originally asked for it, not the operator
 * deciding it -- releasing a hold is "yes, this specific call may happen", not "grant the
 * operator's own broader access to it". `row.input` is exactly what the agent sent; nothing here
 * re-derives or re-validates it beyond whatever the replayed contract's own schema does.
 */
export async function decide(
    input: HoldDecideInput,
    ctx: IServiceContext
): Promise<HoldDecideOutput> {
    return ctx.withLock(`serve.hold:${input.holdId}`, async () => {
        const row = await ctx.db('serve.hold').resolve({ id: input.holdId });
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
        const decidedAt = new Date();

        if (!input.approved) {
            await ctx.db('serve.hold').update({
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
            await ctx.db('serve.hold').update({
                id: input.holdId, status: 'released', decidedBy, decidedAt, reason: input.reason, result,
            });
            return { holdId: input.holdId, status: 'released', result };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await ctx.db('serve.hold').update({
                id: input.holdId, status: 'released', decidedBy, decidedAt, reason: input.reason, error: message,
            });
            return { holdId: input.holdId, status: 'released', error: message };
        }
    });
}
