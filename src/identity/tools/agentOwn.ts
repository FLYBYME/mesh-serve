import { resolveCallerTenant, type IServiceContext } from '@flybyme/mesh';

import type { AgentIssueInput, AgentSaveInput, AgentSaveOutput, AgentTokenOutput } from '../contracts/agent.contract.js';
import { issueAgentToken } from './agentToken.js';
import { agentAccount } from './ensureAgent.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** identity.agent.save -- one of the caller's organization's agent accounts (contracts/agent.contract.ts). */
export async function save(input: AgentSaveInput, ctx: IServiceContext): Promise<AgentSaveOutput> {
    const organizationId = resolveCallerTenant(ctx);

    const account = await agentAccount(ctx, organizationId, input.name, input.displayName, input.role);

    return { userId: account.userId, organizationId: account.organizationId, name: account.name, email: account.email, created: account.created, role: account.roleKey };
}

/** identity.agent.issue -- a token for one of the caller's organization's agent accounts. */
export async function issue(input: AgentIssueInput, ctx: IServiceContext): Promise<AgentTokenOutput> {
    const organizationId = resolveCallerTenant(ctx);

    return issueAgentToken(ctx, organizationId, input.name, input.tokenName, input.expiresInDays * DAY_MS);
}
