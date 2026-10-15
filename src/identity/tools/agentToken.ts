import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { AgentTokenInput, AgentTokenOutput } from '../contracts/agent.contract.js';
import { hashToken, issuedToken } from '../methods/hash.js';
import { resolveEffectiveRoleKeys } from '../methods/roles.js';
import { agentEmail } from './ensureAgent.js';

/** identity.agent.token -- see contracts/agent.contract.ts. */
export async function token(input: AgentTokenInput, ctx: IServiceContext): Promise<AgentTokenOutput> {
    const email = agentEmail(input.organizationId, input.name);

    // Only an agent account of that organization: never a person's, whatever the address says.
    const user = await ctx.db('identity.user').findOne({ query: { email } });
    if (user === undefined || user.kind !== 'agent' || user.agentOf !== input.organizationId) {
        throw new MeshError({ message: `No agent "${input.name}" in organization ${input.organizationId} (identity.agent.ensure makes it).`, code: 'NOT_FOUND', status: 404 });
    }

    // The earlier token of this name stops working before the new one exists.
    const tokens = ctx.db('identity.apiToken');
    const earlier = await tokens.find({ query: { userId: user.id, name: input.tokenName } });
    let revoked = 0;
    for (const old of earlier.filter((t) => t.revokedAt === undefined)) {
        await tokens.update({ id: old.id, revokedAt: new Date() });
        revoked++;
    }

    // The roles it holds in its own organization, and nothing more.
    const held = await resolveEffectiveRoleKeys(user.id, input.organizationId, ctx);
    const roles = [...held];

    const plaintext = issuedToken();
    await tokens.create({ tokenHash: hashToken(plaintext), name: input.tokenName, userId: user.id, roles, organizationId: input.organizationId });
    ctx.logger.info(`[identity] ${email}: token "${input.tokenName}" issued, ${revoked} revoked`);

    return { userId: user.id, email, token: plaintext, roles, revoked };
}
