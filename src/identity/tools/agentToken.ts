import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { AgentTokenInput, AgentTokenOutput } from '../contracts/agent.contract.js';
import { hashToken, issuedToken } from '../methods/hash.js';
import { resolveEffectiveRoleKeys } from '../methods/roles.js';
import { agentEmail } from './ensureAgent.js';

/**
 * A fresh token for an organization's agent account, the earlier one of the same name revoked
 * first, with only the roles that account holds in its own organization. Only ever an agent
 * account's (kind `agent`), never a person's, whatever the address says.
 */
export async function issueAgentToken(
    ctx: IServiceContext,
    organizationId: string,
    name: string,
    tokenName: string,
    expiresInMs: number | undefined,
): Promise<AgentTokenOutput> {
    const email = agentEmail(organizationId, name);

    const user = await ctx.db('identity.user').findOne({ query: { email } });
    if (user === undefined || user.kind !== 'agent' || user.agentOf !== organizationId) {
        throw new MeshError({ message: `No agent "${name}" in organization ${organizationId} (identity.agent.ensure makes it).`, code: 'NOT_FOUND', status: 404 });
    }

    // The earlier token of this name stops working before the new one exists.
    const tokens = ctx.db('identity.apiToken');
    const earlier = await tokens.find({ query: { userId: user.id, name: tokenName } });
    let revoked = 0;
    for (const old of earlier.filter((t) => t.revokedAt === undefined)) {
        await tokens.update({ id: old.id, revokedAt: new Date() });
        revoked++;
    }

    // The roles it holds in its own organization, and nothing more.
    const held = await resolveEffectiveRoleKeys(user.id, organizationId, ctx);
    const roles = [...held];

    const plaintext = issuedToken();
    await tokens.create({
        tokenHash: hashToken(plaintext), name: tokenName, userId: user.id, roles, organizationId,
        ...(expiresInMs !== undefined ? { expiresAt: new Date(Date.now() + expiresInMs) } : {}),
    });
    ctx.logger.info(`[identity] ${email}: token "${tokenName}" issued, ${revoked} revoked`);

    return { userId: user.id, email, token: plaintext, roles, revoked };
}

/** identity.agent.token -- see contracts/agent.contract.ts. */
export async function token(input: AgentTokenInput, ctx: IServiceContext): Promise<AgentTokenOutput> {
    return issueAgentToken(ctx, input.organizationId, input.name, input.tokenName, input.expiresInMs);
}
