/**
 * `approval.request` — park a call.
 *
 * Internal. Only the agent surface calls this, from the destructive rule in `McpService`. A caller
 * who could park their own call could also name their own approver, and an approval you grant
 * yourself is not one.
 */

import { ClientError, type IServiceContext, type z } from '@flybyme/mesh';

import type { ApprovalService } from '../approval.service.js';
import { approvalRequestContract } from '../contracts/approval.contract.js';
import { DEFAULT_TTL_MS } from '../schema/approval.js';
import { callBroker, scopeOf } from '../methods/context.js';

type Input = z.infer<typeof approvalRequestContract['inputSchema']>;
type Output = z.infer<typeof approvalRequestContract['outputSchema']>;

export async function approval_request(
    this: ApprovalService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const tenantId = scopeOf(ctx);
    if (tenantId === undefined) {
        /**
         * Refused rather than defaulted to a global approval.
         *
         * A record with no tenant is one every approver on the platform can read, and its `input`
         * field is a copy of whatever was about to be written. Failing here is loud; the alternative
         * is quiet and is a disclosure.
         */
        throw new ClientError(
            'An approval belongs to an organization: it holds the input of the call it is parking, '
            + 'and an unscoped one would be readable by every approver on the platform. '
            + 'This request resolved no scope.',
            'scope_unresolved', 400,
        );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));

    const created = await callBroker(ctx, 'approval.create', {
        tenantId,
        call: input.call,
        host: input.host,
        input: input.input,
        requestedBy: input.requestedBy,
        requestedAt: now,
        approver: input.approver,
        status: 'pending',
        expiresAt,
    }) as { id: string };

    /**
     * The notification, on the channel that already exists.
     *
     * `decideDelivery` scopes an event per subscriber from their memberships, so a board connected
     * to `/events` in this organization lights up with no new delivery path. Anything beyond a
     * browser is a sink and is not built — which is why `expiresAt` matters: **an approval nobody
     * sees is worse than a refusal**, because the agent waits rather than failing.
     */
    ctx.logger.info(`[approval] ${input.call} parked on ${input.approver} — ${created.id}`);

    return {
        approvalId: created.id,
        status: 'pending',
        approver: input.approver,
        expiresAt: expiresAt.toISOString(),
    };
}
