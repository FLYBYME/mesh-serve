import type { IServiceContext } from '@flybyme/mesh';

import type { AgentRevokeInput, AgentRevokeOutput } from '../contracts/agent.contract.js';
import { agentEmail } from './ensureAgent.js';

/** identity.agent.revoke -- see contracts/agent.contract.ts. */
export async function revoke(input: AgentRevokeInput, ctx: IServiceContext): Promise<AgentRevokeOutput> {
    const user = await ctx.db('identity.user').findOne({ query: { email: agentEmail(input.organizationId, input.name) } });
    if (user === undefined || user.kind !== 'agent' || user.agentOf !== input.organizationId) {
        return { revoked: 0 };
    }

    const tokens = ctx.db('identity.apiToken');
    const live = (await tokens.find({ query: { userId: user.id, name: input.tokenName } })).filter((t) => t.revokedAt === undefined);
    for (const token of live) {
        await tokens.update({ id: token.id, revokedAt: new Date() });
    }

    if (live.length > 0) {
        ctx.logger.info(`[identity] ${user.email}: token "${input.tokenName}" revoked`);
    }

    return { revoked: live.length };
}
