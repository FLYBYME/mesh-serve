/**
 * **Approvals: the rules, not the plumbing.**
 *
 * `spec/mcp.md` §7. What is worth testing here is the handful of decisions that would be quietly
 * wrong forever if they were wrong — who may see a parked call, what happens when nobody answers,
 * whose identity the approved call runs as. Each is a rule that fails silently: an agent polls a
 * little longer, a record says the wrong name, a queue shows one row too many.
 *
 * Driven through the handlers with a fake context rather than a live broker, because every rule
 * below is a decision the handler makes and none of them needs a database to be true.
 */

import { describe, expect, it } from 'vitest';

import { approval_check } from '../../src/approval/tools/check.js';
import { approval_decide, approval_list } from '../../src/approval/tools/decide.js';
import { approval_request } from '../../src/approval/tools/request.js';
import { effectiveStatus, EXPIRED_REASON } from '../../src/approval/methods/expiry.js';
import { satisfiesApprover } from '../../src/approval/schema/approval.js';
import type { ApprovalService } from '../../src/approval/approval.service.js';

// ---------------------------------------------------------------------------- fixtures

interface Call { readonly tool: string; readonly params: unknown; readonly meta?: unknown }

/**
 * A broker that answers from a table and records what it was asked.
 *
 * Recording matters as much as answering: two of the rules below are about *which* call was made
 * and with what identity, and a stub that only returned values could not show either.
 */
function context(rows: Record<string, unknown>, user?: { id: string; tenant_id?: string; roles?: string[] }) {
    const calls: Call[] = [];
    const ctx = {
        meta: user === undefined ? {} : { user, tenant_id: user.tenant_id },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        broker: {
            call: async (tool: string, params: unknown, options?: { meta?: unknown }) => {
                calls.push({ tool, params, ...(options?.meta === undefined ? {} : { meta: options.meta }) });
                if (tool === 'approval.get') {
                    const id = (params as { id: string }).id;
                    return rows[id] ?? null;
                }
                if (tool === 'approval.create') return { id: 'ap-new' };
                if (tool === 'approval.update') return { id: (params as { id: string }).id };
                if (tool === 'approval.find') return Object.values(rows);
                if (tool === 'boom.explode') throw new Error('the call itself failed');
                return { ok: true, ran: tool };
            },
        },
    };
    return { ctx: ctx as never, calls };
}

const service = {} as ApprovalService;

const hour = 60 * 60 * 1000;

const pending = (over: Record<string, unknown> = {}) => ({
    id: 'ap-1',
    tenantId: 'org-1',
    call: 'card.create',
    host: 'flowboard.localhost',
    input: { title: 'a card' },
    requestedBy: { userId: 'u-agent', agent: 'agy-3', roles: ['worker'] },
    requestedAt: new Date(Date.now() - hour),
    approver: 'role:operator',
    status: 'pending',
    expiresAt: new Date(Date.now() + hour),
    ...over,
});

// ---------------------------------------------------------------------------- the rules

describe('who the record names', () => {
    it('matches a role by holding it and a user by being them', () => {
        expect(satisfiesApprover('role:operator', { userId: 'u-1', roles: ['operator'] })).toBe(true);
        expect(satisfiesApprover('role:operator', { userId: 'u-1', roles: ['owner'] })).toBe(false);
        expect(satisfiesApprover('user:u-1', { userId: 'u-1', roles: [] })).toBe(true);
        expect(satisfiesApprover('user:u-1', { userId: 'u-2', roles: ['operator'] })).toBe(false);
    });

    /**
     * An unprefixed string satisfies nobody.
     *
     * `approver` is a free string because the site names it, so a typo — `operator` for
     * `role:operator` — is reachable. It must fail closed: an approval nobody can decide expires,
     * which is visible, where one everybody can decide is a hole nothing reports.
     */
    it('refuses a value with no prefix rather than guessing', () => {
        expect(satisfiesApprover('operator', { userId: 'u-1', roles: ['operator'] })).toBe(false);
    });
});

describe('running out of time', () => {
    it('reads a lapsed pending row as expired without anything having swept it', () => {
        expect(effectiveStatus(pending() as never)).toBe('pending');
        expect(effectiveStatus(pending({ expiresAt: new Date(Date.now() - 1) }) as never)).toBe('expired');
    });

    /** A decision already made is not undone by time passing. */
    it('leaves a decided row alone however old it is', () => {
        const old = { status: 'approved', expiresAt: new Date(Date.now() - hour) } as never;
        expect(effectiveStatus(old)).toBe('approved');
    });

    it('tells the agent that checking again will not help', async () => {
        const { ctx } = context({ 'ap-1': pending({ expiresAt: new Date(Date.now() - 1) }) }, { id: 'u-agent' });
        const answer = await approval_check.call(service, { approvalId: 'ap-1' }, ctx);
        expect(answer.status).toBe('expired');
        expect(answer.reason).toBe(EXPIRED_REASON);
    });
});

describe('who may see a parked call', () => {
    it('answers the requester', async () => {
        const { ctx } = context({ 'ap-1': pending() }, { id: 'u-agent' });
        await expect(approval_check.call(service, { approvalId: 'ap-1' }, ctx)).resolves.toMatchObject({
            status: 'pending', call: 'card.create',
        });
    });

    it('answers an approver', async () => {
        const { ctx } = context({ 'ap-1': pending() }, { id: 'u-tim', roles: ['operator'] });
        await expect(approval_check.call(service, { approvalId: 'ap-1' }, ctx)).resolves.toMatchObject({
            status: 'pending',
        });
    });

    /**
     * **Not yours and not found answer identically.**
     *
     * An approval id points at somebody's frozen input, and a distinguishable "exists but is not
     * yours" turns a guessable id into an oracle for what other organizations are doing.
     */
    it('gives a stranger the same answer as a missing id', async () => {
        const { ctx } = context({ 'ap-1': pending() }, { id: 'u-other', roles: [] });
        const stranger = approval_check.call(service, { approvalId: 'ap-1' }, ctx);
        const missing = approval_check.call(service, { approvalId: 'ap-nope' }, ctx);
        await expect(stranger).rejects.toThrow(/No approval ap-1 that you may see/);
        await expect(missing).rejects.toThrow(/No approval ap-nope that you may see/);
    });
});

describe('deciding', () => {
    it('replays the frozen input rather than asking the agent to call again', async () => {
        const { ctx, calls } = context({ 'ap-1': pending() }, { id: 'u-tim', roles: ['operator'] });
        const answer = await approval_decide.call(service, { approvalId: 'ap-1', approved: true }, ctx);

        expect(answer.status).toBe('approved');
        const replay = calls.find((c) => c.tool === 'card.create');
        expect(replay?.params).toEqual({ title: 'a card' });
    });

    /**
     * The replay runs as the **requester**, in the approval's own scope.
     *
     * A record saying the operator created the card would be a lie in the direction that matters —
     * it hides which program acted. The approver's name rides beside it, not instead of it.
     */
    it('runs as the requester and records who allowed it', async () => {
        const { ctx, calls } = context({ 'ap-1': pending() }, { id: 'u-tim', roles: ['operator'] });
        await approval_decide.call(service, { approvalId: 'ap-1', approved: true }, ctx);

        expect(calls.find((c) => c.tool === 'card.create')?.meta).toMatchObject({
            user: { id: 'u-agent', tenant_id: 'org-1', roles: ['worker'] },
            approvedBy: 'u-tim',
        });
    });

    it('does not run the call when rejected', async () => {
        const { ctx, calls } = context({ 'ap-1': pending() }, { id: 'u-tim', roles: ['operator'] });
        const answer = await approval_decide.call(
            service, { approvalId: 'ap-1', approved: false, reason: 'wrong repo' }, ctx,
        );
        expect(answer.status).toBe('rejected');
        expect(calls.some((c) => c.tool === 'card.create')).toBe(false);
    });

    it('refuses somebody who does not hold the approver role', async () => {
        const { ctx } = context({ 'ap-1': pending() }, { id: 'u-agent', roles: ['worker'] });
        await expect(
            approval_decide.call(service, { approvalId: 'ap-1', approved: true }, ctx),
        ).rejects.toThrow(/may decide/);
    });

    /** The agent may already have read the first answer and acted on it. */
    it('refuses a second decision', async () => {
        const { ctx } = context({ 'ap-1': pending({ status: 'rejected' }) }, { id: 'u-tim', roles: ['operator'] });
        await expect(
            approval_decide.call(service, { approvalId: 'ap-1', approved: true }, ctx),
        ).rejects.toThrow(/already rejected/);
    });

    /**
     * **An approved call that then threw is not a rejection.**
     *
     * Recording it as rejected would blame the approver for a failure that was the call's own, and
     * would tell the agent to stop asking when retrying is exactly what it should weigh.
     */
    it('keeps a failed replay approved and carries the error', async () => {
        const { ctx } = context({ 'ap-1': pending({ call: 'boom.explode' }) }, { id: 'u-tim', roles: ['operator'] });
        const answer = await approval_decide.call(service, { approvalId: 'ap-1', approved: true }, ctx);
        expect(answer.status).toBe('approved');
        expect(answer.error).toMatch(/the call itself failed/);
    });
});

describe('the queue', () => {
    it('shows only rows this caller may actually decide', async () => {
        const rows = {
            mine: pending({ id: 'mine', approver: 'role:operator' }),
            theirs: pending({ id: 'theirs', approver: 'role:billing' }),
        };
        const { ctx } = context(rows, { id: 'u-tim', tenant_id: 'org-1', roles: ['operator'] });
        const answer = await approval_list.call(service, { limit: 50 }, ctx);
        expect(answer.approvals.map((a) => a.approvalId)).toEqual(['mine']);
    });
});

describe('parking', () => {
    /**
     * An unscoped approval would be readable by every approver on the platform, and its `input` is a
     * copy of whatever was about to be written. Refusing is loud; defaulting is a disclosure.
     */
    it('refuses to park a call whose scope did not resolve', async () => {
        const { ctx } = context({}, { id: 'u-agent' });
        await expect(approval_request.call(service, {
            call: 'card.create', host: 'h', input: {},
            requestedBy: { userId: 'u-agent', roles: [] },
            approver: 'role:operator',
        }, ctx)).rejects.toThrow(/resolved no scope/);
    });

    it('writes the frozen input and the named approver', async () => {
        const { ctx, calls } = context({}, { id: 'u-agent', tenant_id: 'org-1' });
        const answer = await approval_request.call(service, {
            call: 'card.create', host: 'flowboard.localhost', input: { title: 'a card' },
            requestedBy: { userId: 'u-agent', agent: 'agy-3', roles: ['worker'] },
            approver: 'role:operator',
        }, ctx);

        expect(answer).toMatchObject({ approvalId: 'ap-new', status: 'pending', approver: 'role:operator' });
        expect(calls.find((c) => c.tool === 'approval.create')?.params).toMatchObject({
            tenantId: 'org-1',
            call: 'card.create',
            input: { title: 'a card' },
            requestedBy: { userId: 'u-agent', agent: 'agy-3' },
        });
    });
});
