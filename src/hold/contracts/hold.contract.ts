import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { holdRuleSchema, holdSchema } from '../schema/hold.js';

/**
 * `create`/`update` stay internal (the default): only `ApiService`'s own interception places a row
 * on hold, and only `serve.hold.decide` ever moves one out of `held` -- neither is a thing an
 * outside caller should ever construct directly. `find`/`get` are `public` so a site can expose
 * them at all; the `role: 'operator'` that actually gates them lives on the `serve.expose` row
 * created for every api automatically (`ApiService`'s `serve.api.create` hook), not here -- same
 * split every other gated read in this codebase uses.
 *
 * Named `serve.hold`, not `approval`: a sibling project (mesh-agents' infer.tools.ts) already uses
 * "approval" for something shaped differently -- a tool-call row's own status field, decided in
 * place -- while this is a separate frozen envelope around an arbitrary contract call, kept apart
 * from the call so the exact original input can be replayed. Same English word, two shapes; `hold`
 * (place on hold / release / reject) avoids the collision and matches this file's neighbors
 * (serve.repo, serve.part, serve.api, serve.cdn, serve.expose) instead of borrowing flowboard's own
 * client-side naming, which is what `approval` had actually done.
 */
export const holdCrud = defineCrud('serve.hold', holdSchema, {
    pluralPath: 'holds',
    scopedBy: 'tenantId',
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: [],
    filePath: 'src/hold/contracts/hold.contract.ts',
    // An organization's admins see its own held calls (scoped by tenantId); an operator passes
    // every gate, in whichever organization it calls (owner, 10-22: a customer decides what its
    // own agents do, not SurfDNS's operator).
    permissions: ['admin'],
});

export type Hold = z.infer<typeof holdCrud.outputSchema>;

export const holdRuleCrud = defineCrud('serve.holdRule', holdRuleSchema, {
    pluralPath: 'hold-rules',
    scopedBy: 'tenantId',
    unique: [['tenantId', 'call']],
    visibility: { find: 'public', findOne: 'public', get: 'public', count: 'public' },
    dependencies: [],
    filePath: 'src/hold/contracts/hold.contract.ts',
    permissions: ['admin'],
});

export type HoldRule = z.infer<typeof holdRuleCrud.outputSchema>;

export const holdAllowInputSchema = z.object({
    call: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*\.[A-Za-z_][A-Za-z0-9_]*$/, 'a domain.action').describe('The call your organization\'s api tokens make'),
    allowed: z.boolean().describe('true: it runs at once; false: it is held for an admin\'s decision again'),
}).strict().describe('Let your organization\'s agents make one call without asking, or make them ask again');

export const holdAllowContract = defineContract({
    domain: 'serve.hold',
    action: 'allow',
    description: 'Let your organization\'s api tokens (its agents) make one destructive call at once instead of holding it for a decision, or hold it again.',
    inputSchema: holdAllowInputSchema,
    outputSchema: z.object({ call: z.string(), allowed: z.boolean() }),
    rest: { method: 'POST', path: '/hold/allow' },
    visibility: 'public',
    dependencies: ['serve.holdRule'],
    // Not destructive on purpose, as decide: an agent's own token never reaches it (admin), and
    // marking it destructive would hold an admin's token asking for it.
    filePath: 'src/hold/tools/allow.ts', concurrency: 'on-demand', permissions: ['admin'],
    print: (o) => `${o.call}: ${o.allowed ? 'runs at once' : 'held for a decision'}`,
});

export type HoldAllowInput = z.infer<typeof holdAllowContract.inputSchema>;
export type HoldAllowOutput = z.infer<typeof holdAllowContract.outputSchema>;

export const holdDecideInputSchema = z.object({
    holdId: z.string().min(1).describe('The held call to decide'),
    approved: z.boolean().describe('True to replay the frozen call, false to reject it'),
    reason: z.string().optional().describe('Recorded on the row, shown to whoever asked'),
}).describe('Release or reject a call that is on hold');

export const holdDecideOutputSchema = z.object({
    holdId: z.string(),
    status: z.enum(['held', 'released', 'rejected', 'expired']),
    result: z.unknown().optional().describe('The replayed call\'s own result, when released'),
    error: z.string().optional().describe('The replayed call\'s own error message, when releasing it failed'),
}).describe('The outcome of deciding a held call');

export const holdDecideContract = defineContract({
    domain: 'serve.hold',
    action: 'decide',
    description: 'Release or reject a call an agent asked to make, replaying it if released.',
    inputSchema: holdDecideInputSchema,
    outputSchema: holdDecideOutputSchema,
    rest: { method: 'POST', path: '/hold/decide' },
    visibility: 'public',
    dependencies: ['serve.hold'],
    // Two concurrent decide calls on the same hold (a double-click, a retried request) could both
    // pass the "still held" check before either writes -- leaderScoped + withLock (in decide.ts)
    // close that the same way infer.provider.acquire/release do.
    leaderScoped: true,
    // Approves or denies a held call, which then runs under the original requester's identity.
    // An admin decides its own organization's held calls (the row is read in its scope); an
    // operator any organization's, calling in it.
    filePath: 'src/hold/tools/decide.ts', concurrency: 'on-demand', permissions: ['admin'],
    print: (o) => `${o.holdId}: ${o.status}`,
});

export type HoldDecideInput = z.infer<typeof holdDecideContract.inputSchema>;
export type HoldDecideOutput = z.infer<typeof holdDecideContract.outputSchema>;
