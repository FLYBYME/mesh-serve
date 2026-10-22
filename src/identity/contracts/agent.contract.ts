import { defineContract, z } from '@flybyme/mesh';

/**
 * identity.agent.ensure -- an organization's agent account, made the first time and found after.
 *
 * An agent acts for one organization by its own tokens, never a person's: a token is only as narrow
 * as its account (a token of the owner's account carried the owner's repository grants, 2026-10-05).
 * The account is a member of that organization only, with the `agent` role, which inherits nothing;
 * it has no password, so it cannot sign in. Its tokens are issued by identity.apiToken.issue
 * (`userId`, an operator's call), by the platform service that seals them in the vault: no person
 * ever sees one.
 */
export const agentEnsureInputSchema = z.object({
    organizationId: z.string().min(1).describe('The organization it works for'),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes').describe('Which agent: dev, leader, builds'),
    displayName: z.string().min(1).max(80).optional().describe('How it is shown: "Dev agent"'),
});

export const agentEnsureOutputSchema = z.object({
    userId: z.string(),
    organizationId: z.string(),
    name: z.string(),
    email: z.string().describe('Its account address: never a mailbox, only a unique name'),
    created: z.boolean(),
});

export const agentEnsureContract = defineContract({
    domain: 'identity.agent',
    action: 'ensure',
    description: 'Make or find an organization\'s agent account: a member of that organization only, with the agent role, no password. It acts only by its own tokens.',
    inputSchema: agentEnsureInputSchema,
    outputSchema: agentEnsureOutputSchema,
    rest: { method: 'POST', path: '/identity/agents/ensure' },
    dependencies: ['identity.user', 'identity.organization', 'identity.membership', 'identity.role'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/ensureAgent.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.email} (${o.userId}) for ${o.organizationId}${o.created ? ', made' : ''}`,
});

export type AgentEnsureInput = z.infer<typeof agentEnsureInputSchema>;
export type AgentEnsureOutput = z.infer<typeof agentEnsureOutputSchema>;

/**
 * identity.agent.token -- a fresh token for an organization's agent account, the earlier one of the
 * same name revoked first (open.md, "the dev agent from an order", proposed 10-10, done 10-14).
 *
 * Only ever an agent account's (kind `agent`, made by identity.agent.ensure), never a person's, and
 * only the roles that account holds in its own organization. Internal: no api can expose it, so only
 * a service inside the mesh can ask (builds, sealing it straight into the vault when an organization
 * is set up to build). An operator issuing another account's token is identity.apiToken.issue.
 */
export const agentTokenInputSchema = z.object({
    organizationId: z.string().min(1).describe('The organization the agent works for'),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes').describe('Which agent: dev, leader, builds'),
    tokenName: z.string().min(1).max(64).describe('The token\'s name: an earlier token of this name is revoked'),
    expiresInMs: z.number().int().positive().optional().describe('How long it is valid for, from now (a workflow job\'s token: the job\'s own limit). Absent: until revoked'),
});

export const agentTokenOutputSchema = z.object({
    userId: z.string(),
    email: z.string(),
    token: z.string().describe('The plaintext token: only ever in this reply'),
    roles: z.array(z.string()),
    revoked: z.number().int().describe('Earlier tokens of the same name revoked'),
});

export const agentTokenContract = defineContract({
    domain: 'identity.agent',
    action: 'token',
    description: 'A fresh token for an organization\'s agent account (never a person\'s), the earlier one of the same name revoked. Internal: services only.',
    inputSchema: agentTokenInputSchema,
    outputSchema: agentTokenOutputSchema,
    // A path every contract has; `internal` keeps it from ever being served.
    rest: { method: 'POST', path: '/identity/agents/token' },
    dependencies: ['identity.user', 'identity.organization', 'identity.membership', 'identity.apiToken', 'identity.role'],
    visibility: 'internal',
    destructive: true,
    filePath: 'src/identity/tools/agentToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.email}: a token issued (${o.revoked} revoked)`,
});

export type AgentTokenInput = z.infer<typeof agentTokenInputSchema>;
export type AgentTokenOutput = z.infer<typeof agentTokenOutputSchema>;

/**
 * identity.agent.revoke -- an agent account's token of one name stops working (a workflow job's,
 * when the job ends). Internal, like identity.agent.token: the service that asked for the token
 * ends it; identity.apiToken.revoke is a person's own, or an operator's.
 */
export const agentRevokeInputSchema = z.object({
    organizationId: z.string().min(1).describe('The organization the agent works for'),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes').describe('Which agent'),
    tokenName: z.string().min(1).max(64).describe('The token to revoke, by name'),
});

export const agentRevokeOutputSchema = z.object({
    revoked: z.number().int().describe('Tokens revoked by this call -- 0 when none was live'),
});

export const agentRevokeContract = defineContract({
    domain: 'identity.agent',
    action: 'revoke',
    description: 'Revoke an organization\'s agent account\'s token of one name. Internal: services only.',
    inputSchema: agentRevokeInputSchema,
    outputSchema: agentRevokeOutputSchema,
    rest: { method: 'POST', path: '/identity/agents/revoke' },
    dependencies: ['identity.user', 'identity.apiToken'],
    visibility: 'internal',
    destructive: true,
    filePath: 'src/identity/tools/agentRevoke.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.revoked} revoked`,
});

/**
 * identity.agent.save / identity.agent.issue -- an organization's admins make their own agent
 * accounts and get their tokens (owner, 10-22: Peera, a customer, needs an agent of its own that
 * works as a member would, and only the operator could make one).
 *
 * The caller's own organization only, never another's: it is the call's organization, not an input.
 * The role is the admin's choice: `member` for an employee that works as a member of the
 * organization would (never an admin: an agent never manages people or the organization), `agent`
 * for one that reaches only what is exposed for agents. The admin sees the token once, as with
 * their own (identity.apiToken.issue).
 */
const AGENT_NAME = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes');

export const agentSaveInputSchema = z.object({
    name: AGENT_NAME.describe('Which agent: peera, bookkeeper'),
    displayName: z.string().min(1).max(80).optional().describe('How it is shown: "Peera"'),
    role: z.enum(['member', 'agent']).default('member').describe('member: works as a member of your organization would; agent: only what is exposed for agents'),
}).strict();

export const agentSaveOutputSchema = agentEnsureOutputSchema.extend({ role: z.enum(['member', 'agent']) });

export const agentSaveContract = defineContract({
    domain: 'identity.agent',
    action: 'save',
    description: 'Make one of your organization\'s agent accounts, or change its role: an account with no password that acts only by its tokens, as a member of your organization (or with the narrow agent role).',
    inputSchema: agentSaveInputSchema,
    outputSchema: agentSaveOutputSchema,
    rest: { method: 'POST', path: '/identity/agents/save' },
    dependencies: ['identity.user', 'identity.organization', 'identity.membership', 'identity.role'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/agentOwn.ts', concurrency: 'on-demand', permissions: ['admin'],
    print: (o) => `${o.email} (${o.userId}), ${o.role}${o.created ? ', made' : ''}`,
});

export const agentIssueInputSchema = z.object({
    name: AGENT_NAME.describe('Which of your organization\'s agents'),
    tokenName: z.string().min(1).max(64).describe('The token\'s name: an earlier token of this name stops working'),
    expiresInDays: z.number().int().min(1).max(365).default(90),
}).strict();

export const agentIssueContract = defineContract({
    domain: 'identity.agent',
    action: 'issue',
    description: 'A token for one of your organization\'s agent accounts, with the roles it holds there; an earlier token of the same name stops working. Shown once.',
    inputSchema: agentIssueInputSchema,
    outputSchema: agentTokenOutputSchema,
    rest: { method: 'POST', path: '/identity/agents/issue' },
    dependencies: ['identity.user', 'identity.organization', 'identity.membership', 'identity.apiToken', 'identity.role'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/agentOwn.ts', concurrency: 'on-demand', permissions: ['admin'],
    print: (o) => `${o.email}: a token issued (${o.revoked} revoked), roles ${o.roles.join(', ')}`,
});

/** identity.agent.find -- the caller's organization's agent accounts, each with its role there. */
export const agentFindOutputSchema = z.array(z.object({
    userId: z.string(),
    name: z.string().describe('Which agent: peera'),
    displayName: z.string(),
    email: z.string().describe('Its account address: never a mailbox'),
    role: z.string().describe('Its role in the organization: member or agent'),
}));

export const agentFindContract = defineContract({
    domain: 'identity.agent',
    action: 'find',
    description: 'Your organization\'s agent accounts, each with its role.',
    inputSchema: z.object({}).strict(),
    outputSchema: agentFindOutputSchema,
    rest: { method: 'GET', path: '/identity/agents' },
    dependencies: ['identity.user', 'identity.membership'],
    visibility: 'public',
    destructive: false,
    filePath: 'src/identity/tools/agentOwn.ts', concurrency: 'on-demand', permissions: ['member'],
    print: (o) => o.map((a) => `${a.name} (${a.role})`).join('\n'),
});

export type AgentFindOutput = z.infer<typeof agentFindOutputSchema>;
export type AgentSaveInput = z.infer<typeof agentSaveInputSchema>;
export type AgentSaveOutput = z.infer<typeof agentSaveOutputSchema>;
export type AgentIssueInput = z.infer<typeof agentIssueInputSchema>;

export type AgentRevokeInput = z.infer<typeof agentRevokeInputSchema>;
export type AgentRevokeOutput = z.infer<typeof agentRevokeOutputSchema>;
