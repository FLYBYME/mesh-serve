import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { AgentEnsureInput, AgentEnsureOutput } from '../contracts/agent.contract.js';

/** An agent account's address: unique per organization and name, and no mailbox (`.invalid` never resolves). */
export function agentEmail(organizationId: string, name: string): string {
    return `${name}@${organizationId}.agents.invalid`;
}

/** identity.agent.ensure -- see contracts/agent.contract.ts. */
export async function ensure(input: AgentEnsureInput, ctx: IServiceContext): Promise<AgentEnsureOutput> {
    const org = await ctx.db('identity.organization').resolve({ id: input.organizationId });
    if (org === undefined) {
        throw new MeshError({ message: `No organization "${input.organizationId}".`, code: 'NOT_FOUND', status: 404 });
    }

    const email = agentEmail(org.id, input.name);
    const users = ctx.db('identity.user');

    let user = await users.findOne({ query: { email } });
    const created = user === undefined;
    if (user === undefined) {
        user = await users.create({
            email,
            displayName: input.displayName ?? `${input.name} agent`,
            roles: [],
            kind: 'agent',
            agentOf: org.id,
        });
    } else if (user.kind !== 'agent' || user.agentOf !== org.id) {
        // An address of this shape that is not this organization's agent: never take it over.
        throw new MeshError({ message: `${email} is not ${org.name}'s agent account.`, code: 'CONFLICT', status: 409 });
    }

    // Its one membership: the agent role in its organization.
    await ctx.call('identity.membership.assign', { organizationId: org.id, userId: user.id, roleKey: 'agent' });

    if (created) {
        ctx.logger.info(`[identity] agent account ${email} made for ${org.name}`);
    }

    return { userId: user.id, organizationId: org.id, name: input.name, email, created };
}
