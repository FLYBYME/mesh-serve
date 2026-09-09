/**
 * The approval contracts.
 *
 * Three doors, and they are deliberately different sizes:
 *
 * - `approval.request` is **internal**. Only the MCP surface raises one, from the destructive rule.
 *   A caller who could ask for an approval directly could name their own approver, which is the
 *   whole game.
 * - `approval.check` is **public**, gated at `user`, and answers only to the requester or an
 *   approver. It is what an agent polls, because the transport cannot push.
 * - `approval.decide` and `approval.list` are for the person. `list` is how a board shows a queue.
 *
 * `approval.check` and `approval.decide` are both `destructive: false` on purpose even though
 * `decide` plainly writes: `destructive` on this surface means *needs a person's confirmation*, and
 * a person confirming is what `decide` **is**. Marking it destructive would mean an approval needed
 * an approval.
 */

import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { ApprovalSchema, ApprovalStatusEnum, RequesterSchema } from '../schema/approval.js';

/**
 * The collection. Every action internal: the three contracts below are the interface, and a
 * generated `approval.update` reaching `status` would be a decision with none of the checks.
 *
 * `scopedBy: 'tenantId'` for the reason written on the field — an unscoped collection here would
 * publish every pending call's frozen input to every approver on the platform.
 */
export const approvalCrud = defineCrud('approval', ApprovalSchema, {
    pluralPath: 'approvals',
    scopedBy: 'tenantId',
    visibility: {
        find: 'internal', findOne: 'internal', get: 'internal', resolve: 'internal',
        count: 'internal', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredApproval = z.infer<typeof approvalCrud['outputSchema']>;

export const approvalRequestContract = defineContract({
    domain: 'approval',
    action: 'request',
    description: 'Park a call until a person decides it. Raised by the agent surface, never by a caller.',
    inputSchema: z.object({
        call: z.string().min(1),
        host: z.string().default(''),
        input: z.record(z.string(), z.unknown()).default({}),
        requestedBy: RequesterSchema,
        approver: z.string().min(1),
        ttlMs: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
        approvalId: z.string(),
        status: ApprovalStatusEnum,
        approver: z.string(),
        expiresAt: z.string(),
    }),
    rest: { method: 'POST', path: '/approval/request' },
    visibility: 'internal',
    destructive: true,
    print: (o) => `approval ${o.approvalId} pending on ${o.approver}`,
});

/**
 * What the agent polls.
 *
 * Returns the decision *and the result of the replayed call* when there is one, so an approved
 * request needs no second call from the agent. `pending` is a perfectly ordinary answer and is not
 * an error — an agent that treats waiting as failure gives up on every approval.
 */
export const approvalCheckContract = defineContract({
    domain: 'approval',
    action: 'check',
    description:
        'Check a parked call. Answers pending, approved (with the call result), rejected (with a '
        + 'reason), or expired. Poll this after a call answers with status "pending".',
    inputSchema: z.object({
        approvalId: z.string().min(1).describe('The id returned when the call was parked'),
    }),
    outputSchema: z.object({
        approvalId: z.string(),
        status: ApprovalStatusEnum,
        call: z.string(),
        approver: z.string(),
        expiresAt: z.string(),
        decidedBy: z.string().optional(),
        decidedAt: z.string().optional(),
        reason: z.string().optional(),
        result: z.unknown().optional(),
        error: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/approval/check' },
    visibility: 'public',
    destructive: false,
    print: (o) => `${o.call}: ${o.status}`,
});

/**
 * The person's door.
 *
 * Approving **replays the frozen input** rather than telling the agent to try again. An agent that
 * re-called could send input other than the one the approver read, which would make the approval a
 * decision about something that never happened.
 */
export const approvalDecideContract = defineContract({
    domain: 'approval',
    action: 'decide',
    description: 'Approve or reject a parked call. Approving runs it with the input that was frozen when it was asked.',
    inputSchema: z.object({
        approvalId: z.string().min(1),
        approved: z.boolean(),
        reason: z.string().optional().describe('Why. Shown to the agent — worth writing for one.'),
    }),
    outputSchema: z.object({
        approvalId: z.string(),
        status: ApprovalStatusEnum,
        result: z.unknown().optional(),
        error: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/approval/decide' },
    visibility: 'public',
    destructive: false,
    print: (o) => `${o.approvalId}: ${o.status}`,
});

/** The queue a board renders. Answers only what this caller may decide. */
export const approvalListContract = defineContract({
    domain: 'approval',
    action: 'list',
    description: 'Parked calls this caller may decide.',
    inputSchema: z.object({
        status: ApprovalStatusEnum.optional(),
        limit: z.number().int().positive().max(200).default(50),
    }),
    outputSchema: z.object({
        approvals: z.array(z.object({
            approvalId: z.string(),
            call: z.string(),
            host: z.string(),
            status: ApprovalStatusEnum,
            requestedBy: RequesterSchema,
            requestedAt: z.string(),
            expiresAt: z.string(),
            input: z.record(z.string(), z.unknown()),
        })),
    }),
    rest: { method: 'GET', path: '/approvals' },
    visibility: 'public',
    destructive: false,
    print: (o) => `${o.approvals.length} awaiting a decision`,
});
