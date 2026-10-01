import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { ActivityMineInput, ActivityMineOutput } from '../contracts/activity.contract.js';

/** The caller's organization's rows from the (global) activity log, newest first. */
export async function mine(input: ActivityMineInput, ctx: IServiceContext): Promise<ActivityMineOutput> {
    // The organization the gateway ran this call in -- a member's own, checked against their
    // membership; never anything from the input.
    const userId = ctx.meta?.user?.id;
    const organizationId = ctx.meta?.user?.tenant_id;
    if (userId === undefined || userId === '' || organizationId === undefined || organizationId === '') {
        throw new MeshError({ message: 'Sign in to see your organization\'s activity.', code: 'UNAUTHENTICATED', status: 401 });
    }
    // The organization's, and the caller's own wherever it ran: a call anyone may make (signing in,
    // changing a password) runs in the api's own organization, and would otherwise be missing.
    const rows = await ctx.db('serve.activity').find({
        query: {
            $or: [{ organizationId }, { 'actor.userId': userId }],
            ...(input.before !== undefined ? { at: { $lt: input.before } } : {}),
        },
        sort: '-at',
        limit: input.limit,
    });
    return {
        rows: rows.map((r) => ({
            at: r.at,
            contract: r.contract,
            outcome: r.outcome,
            actor: r.actor,
            input: r.input,
            ...(r.error !== undefined ? { error: r.error } : {}),
        })),
    };
}
