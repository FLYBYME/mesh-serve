import { resolveCallerTenant, type IServiceContext } from '@flybyme/mesh';

import type { AgentFindOutput, AgentIssueInput, AgentSaveInput, AgentSaveOutput, AgentTokenOutput } from '../contracts/agent.contract.js';
import { issueAgentToken } from './agentToken.js';
import { agentAccount } from './ensureAgent.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** identity.agent.save -- one of the caller's organization's agent accounts (contracts/agent.contract.ts). */
export async function save(input: AgentSaveInput, ctx: IServiceContext): Promise<AgentSaveOutput> {
    const organizationId = resolveCallerTenant(ctx);

    const account = await agentAccount(ctx, organizationId, input.name, input.displayName, input.role);

    return { userId: account.userId, organizationId: account.organizationId, name: account.name, email: account.email, created: account.created, role: account.roleKey };
}

/** identity.agent.find -- the caller's organization's agent accounts, each with its role there. */
export async function find(_input: Record<string, never>, ctx: IServiceContext): Promise<AgentFindOutput> {
    const organizationId = resolveCallerTenant(ctx);

    const agents = await ctx.db('identity.user').find({ query: { kind: 'agent', agentOf: organizationId } });
    const memberships = ctx.db('identity.membership', { user: { id: 'identity', tenant_id: organizationId, organizationId } });

    const out: AgentFindOutput = [];
    for (const agent of agents) {
        const membership = await memberships.findOne({ query: { userId: agent.id } });

        out.push({
            userId: agent.id,
            name: agent.email.slice(0, agent.email.indexOf('@')),
            displayName: agent.displayName,
            email: agent.email,
            role: membership?.roleKey ?? 'none',
        });
    }

    return out;
}

/** identity.agent.issue -- a token for one of the caller's organization's agent accounts. */
export async function issue(input: AgentIssueInput, ctx: IServiceContext): Promise<AgentTokenOutput> {
    const organizationId = resolveCallerTenant(ctx);

    return issueAgentToken(ctx, organizationId, input.name, input.tokenName, input.expiresInDays * DAY_MS);
}
