/**
 * `approval.decide` — the person's door.
 *
 * Approving **replays the frozen input**. The agent is never told to try again: an agent that
 * re-called could send input other than the one the approver read, which would make the approval a
 * decision about a call that never happened.
 *
 * The replay runs **as the requester**, not as the approver. That is what keeps the audit honest in
 * both directions — the call was made by the agent, and it was allowed by a named person — and it is
 * why `requestedBy` is on the record rather than derived.
 */

import { ClientError, type IServiceContext, type z } from '@flybyme/mesh';

import type { ApprovalService } from '../approval.service.js';
import { approvalDecideContract, approvalListContract } from '../contracts/approval.contract.js';
import { satisfiesApprover, type Approval } from '../schema/approval.js';
import { callBroker, callerOf, scopeOf } from '../methods/context.js';
import { effectiveStatus } from '../methods/expiry.js';

type Input = z.infer<typeof approvalDecideContract['inputSchema']>;
type Output = z.infer<typeof approvalDecideContract['outputSchema']>;

export async function approval_decide(
    this: ApprovalService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = callerOf(ctx);
    if (caller === undefined) {
        throw new ClientError('Deciding an approval requires a caller.', 'caller_unknown', 401);
    }

    const row = await callBroker(ctx, 'approval.get', { id: input.approvalId }) as Approval & { id: string } | null;
    if (row === null || row === undefined || !satisfiesApprover(row.approver, caller)) {
        // Same reasoning as `check`: an id is guessable and points at somebody's frozen input.
        throw new ClientError(`No approval ${input.approvalId} that you may decide.`, 'not_found', 404);
    }

    const status = effectiveStatus(row);
    if (status !== 'pending') {
        /**
         * A decided approval is not re-decidable, and an expired one is not revivable.
         *
         * Refusing rather than overwriting: the agent may already have read `rejected` and moved on,
         * and a second decision that silently replaced the first would mean the record and the
         * agent's behaviour disagree with nobody able to tell.
         */
        throw new ClientError(
            `${input.approvalId} is already ${status}. A decision is made once.`,
            'already_decided', 409,
        );
    }

    if (!input.approved) {
        await callBroker(ctx, 'approval.update', {
            id: input.approvalId,
            status: 'rejected',
            decidedBy: caller.userId,
            decidedAt: new Date(),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        ctx.logger.info(`[approval] ${row.call} rejected by ${caller.userId} — ${input.approvalId}`);
        return { approvalId: input.approvalId, status: 'rejected' };
    }

    /**
     * Approved. Run it.
     *
     * `meta` is rebuilt for the **requester**, with the scope this approval belongs to. Not the
     * approver's identity — a record saying the operator created the card would be a lie — and not
     * the approver's scope, which could differ if they hold several memberships.
     */
    const meta = {
        user: {
            id: row.requestedBy.userId,
            tenant_id: row.tenantId,
            roles: [...row.requestedBy.roles],
        },
        tenant_id: row.tenantId,
        /**
         * The one thing the replay carries that the original call did not.
         *
         * A handler that wants to know it is running because somebody said yes can read it. Nothing
         * reads it today; it is on the record either way and omitting it here would mean the
         * information exists everywhere except where the call can see it.
         */
        approvedBy: caller.userId,
    };

    try {
        const result = await callBroker(ctx, row.call, row.input, { meta });
        await callBroker(ctx, 'approval.update', {
            id: input.approvalId,
            status: 'approved',
            decidedBy: caller.userId,
            decidedAt: new Date(),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            result: result ?? null,
        });
        ctx.logger.info(`[approval] ${row.call} approved by ${caller.userId} — ${input.approvalId}`);
        return { approvalId: input.approvalId, status: 'approved', result };
    } catch (error) {
        /**
         * **An approved call that then threw is not a rejection.**
         *
         * The person said yes; the call failed on its own terms. Recording it as `rejected` would
         * blame them for it, and would tell the agent to stop asking when retrying is exactly what
         * it should consider. So the status is `approved` and the failure rides beside it.
         */
        const message = error instanceof Error ? error.message : String(error);
        await callBroker(ctx, 'approval.update', {
            id: input.approvalId,
            status: 'approved',
            decidedBy: caller.userId,
            decidedAt: new Date(),
            error: message,
        });
        ctx.logger.warn(`[approval] ${row.call} approved but failed — ${input.approvalId}: ${message}`);
        return { approvalId: input.approvalId, status: 'approved', error: message };
    }
}

/** `approval.list` — the queue a board renders. */
export async function approval_list(
    this: ApprovalService,
    input: z.infer<typeof approvalListContract['inputSchema']>,
    ctx: IServiceContext,
): Promise<z.infer<typeof approvalListContract['outputSchema']>> {
    const caller = callerOf(ctx);
    if (caller === undefined) {
        throw new ClientError('Listing approvals requires a caller.', 'caller_unknown', 401);
    }
    const tenantId = scopeOf(ctx);
    if (tenantId === undefined) return { approvals: [] };

    const rows = await callBroker(ctx, 'approval.find', {
        query: input.status === undefined ? {} : { status: input.status },
        limit: input.limit,
        sort: '-requestedAt',
    }) as (Approval & { id: string })[];

    return {
        approvals: rows
            // Only what this caller may actually act on. A queue showing rows somebody cannot decide
            // is a queue they learn to ignore.
            .filter((row) => satisfiesApprover(row.approver, caller))
            .map((row) => ({
                approvalId: row.id,
                call: row.call,
                host: row.host,
                status: effectiveStatus(row),
                requestedBy: row.requestedBy,
                requestedAt: new Date(row.requestedAt).toISOString(),
                expiresAt: new Date(row.expiresAt).toISOString(),
                input: row.input,
            })),
    };
}
