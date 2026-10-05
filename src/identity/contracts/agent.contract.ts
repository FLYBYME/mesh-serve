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
