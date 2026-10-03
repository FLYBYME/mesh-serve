import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { OrganizationRemoveInput, OrganizationRemoveOutput } from '../contracts/organization.contract.js';

/**
 * identity.organization.remove: the organization's memberships, then the organization. Written with
 * that organization's own scope (as assignMembership does), never the caller's. The platform's own
 * organization is refused: everything the api is runs under it.
 */
export async function removeOrganization(input: OrganizationRemoveInput, ctx: IServiceContext): Promise<OrganizationRemoveOutput> {
    const org = await ctx.db('identity.organization').resolve({ id: input.organizationId });
    if (org === undefined) throw new MeshError({ message: `No organization "${input.organizationId}".`, code: 'NOT_FOUND', status: 404 });

    if (org.slug === 'platform') throw new MeshError({ message: 'The platform\'s own organization cannot be removed.', code: 'FORBIDDEN', status: 403 });

    const memberships = ctx.db('identity.membership', { user: { id: ctx.meta?.user?.id ?? '', tenant_id: org.id, organizationId: org.id } });
    const members = await memberships.find({ query: {}, limit: 1000 });

    for (const m of members) await memberships.delete({ id: m.id });

    await ctx.db('identity.organization').delete({ id: org.id });

    ctx.logger.info(`[identity] organization ${org.name} (${org.id}) removed, with ${members.length} memberships`);

    return { organizationId: org.id, name: org.name, memberships: members.length };
}
