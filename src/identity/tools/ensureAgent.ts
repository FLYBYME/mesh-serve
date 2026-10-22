import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { AgentEnsureInput, AgentEnsureOutput } from '../contracts/agent.contract.js';

/** An agent account's address: unique per organization and name, and no mailbox (`.invalid` never resolves). */
export function agentEmail(organizationId: string, name: string): string {
    return `${name}@${organizationId}.agents.invalid`;
}

/** The role an agent account holds in its organization: `agent` (a service's, narrow) or `member` (an organization's own employee). */
export type AgentRoleKey = 'agent' | 'member';

/**
 * An organization's agent account, made the first time, found after, and holding `roleKey` in its
 * organization: its one membership, written here rather than through identity.membership.assign,
 * which checks a person's right to change a membership -- and a service making its own account is
 * no member (workflows' ci agent was refused, 10-21).
 */
export async function agentAccount(
    ctx: IServiceContext,
    organizationId: string,
    name: string,
    displayName: string | undefined,
    roleKey: AgentRoleKey,
): Promise<AgentEnsureOutput & { roleKey: AgentRoleKey }> {
    const org = await ctx.db('identity.organization').resolve({ id: organizationId });
    if (org === undefined) {
        throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });
    }

    const email = agentEmail(org.id, name);
    const users = ctx.db('identity.user');

    let user = await users.findOne({ query: { email } });
    const created = user === undefined;
    if (user === undefined) {
        user = await users.create({
            email,
            displayName: displayName ?? `${name} agent`,
            roles: [],
            kind: 'agent',
            agentOf: org.id,
        });
    } else if (user.kind !== 'agent' || user.agentOf !== org.id) {
        // An address of this shape that is not this organization's agent: never take it over.
        throw new MeshError({ message: `${email} is not ${org.name}'s agent account.`, code: 'CONFLICT', status: 409 });
    }

    const memberships = ctx.db('identity.membership', { user: { id: user.id, tenant_id: org.id, organizationId: org.id } });
    const membership = await memberships.findOne({ query: { userId: user.id } });
    if (membership === undefined) {
        await memberships.create({ userId: user.id, organizationId: org.id, roleKey, invitedBy: ctx.meta?.user?.id ?? '', joinedAt: new Date() });
    } else if (membership.roleKey !== roleKey) {
        await memberships.update({ id: membership.id, roleKey });
    }

    if (created) {
        ctx.logger.info(`[identity] agent account ${email} made for ${org.name}, as ${roleKey}`);
    }

    return { userId: user.id, organizationId: org.id, name, email, created, roleKey };
}

/** identity.agent.ensure -- see contracts/agent.contract.ts. A service's agent: the agent role, which inherits nothing. */
export async function ensure(input: AgentEnsureInput, ctx: IServiceContext): Promise<AgentEnsureOutput> {
    const account = await agentAccount(ctx, input.organizationId, input.name, input.displayName, 'agent');

    return { userId: account.userId, organizationId: account.organizationId, name: account.name, email: account.email, created: account.created };
}
