/**
 * `approval.check` — what an agent polls.
 *
 * Polling, and not because polling is good. `McpService.#handle` is POST-only and answers GET with
 * 405 because *"nothing here initiates anything"* — **the transport cannot push**, so an agent
 * cannot be told. The alternative is holding an HTTP connection open for something a person may
 * answer tomorrow, which is worse.
 */

import { ClientError, type IServiceContext, type z } from '@flybyme/mesh';

import type { ApprovalService } from '../approval.service.js';
import { approvalCheckContract } from '../contracts/approval.contract.js';
import { satisfiesApprover, type Approval } from '../schema/approval.js';
import { callBroker, callerOf } from '../methods/context.js';
import { effectiveStatus, EXPIRED_REASON } from '../methods/expiry.js';

type Input = z.infer<typeof approvalCheckContract['inputSchema']>;
type Output = z.infer<typeof approvalCheckContract['outputSchema']>;

export async function approval_check(
    this: ApprovalService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = callerOf(ctx);
    if (caller === undefined) {
        throw new ClientError('Checking an approval requires a caller.', 'caller_unknown', 401);
    }

    const row = await callBroker(ctx, 'approval.get', { id: input.approvalId }) as Approval & { id: string } | null;

    /**
     * **Not found and not yours answer the same way, and that is deliberate.**
     *
     * A distinguishable "exists but is not yours" turns this into an oracle: an id is guessable, and
     * the answer would say which calls other organizations are making. `McpService` makes the
     * opposite choice for tool names — *"a tool nobody exposes is a mistake in the caller; a tool
     * this caller may not reach is a fact about the caller"* — because a tool name is public and an
     * approval id points at somebody's frozen input.
     */
    const visible = row !== null && row !== undefined
        && (row.requestedBy.userId === caller.userId || satisfiesApprover(row.approver, caller));

    if (!visible || row === null || row === undefined) {
        throw new ClientError(
            `No approval ${input.approvalId} that you may see.`,
            'not_found', 404,
        );
    }

    const status = effectiveStatus(row);

    return {
        approvalId: input.approvalId,
        status,
        call: row.call,
        approver: row.approver,
        expiresAt: new Date(row.expiresAt).toISOString(),
        ...(row.decidedBy === undefined ? {} : { decidedBy: row.decidedBy }),
        ...(row.decidedAt === undefined ? {} : { decidedAt: new Date(row.decidedAt).toISOString() }),
        // A pending row that has run out of time carries no stored reason, so it is written here.
        ...(status === 'expired' && row.reason === undefined
            ? { reason: EXPIRED_REASON }
            : row.reason === undefined ? {} : { reason: row.reason }),
        ...(row.result === undefined ? {} : { result: row.result }),
        ...(row.error === undefined ? {} : { error: row.error }),
    };
}
