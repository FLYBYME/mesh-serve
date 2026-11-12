import { MeshError, resolveCallerTenant, resolveCallerUserId } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { OrganizationRenameInput, OrganizationRenameOutput } from '../contracts/organization.contract.js';

/**
 * identity.organization.rename: the caller's own organization, renamed by one of its owners or admins
 * (their membership there, read with that organization's scope). Only the name changes.
 */
export async function renameOrganization(input: OrganizationRenameInput, ctx: IServiceContext): Promise<OrganizationRenameOutput> {
    const userId = resolveCallerUserId(ctx);
    const organizationId = resolveCallerTenant(ctx);

    const org = await ctx.db('identity.organization').resolve({ id: organizationId });
    if (org === undefined) throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });

    const membership = await ctx.db('identity.membership').findOne({ query: { userId, organizationId } });
    if (membership === undefined || (membership.roleKey !== 'owner' && membership.roleKey !== 'admin')) {
        throw new MeshError({ message: `Only an owner or admin of ${org.name} may rename it.`, code: 'FORBIDDEN', status: 403 });
    }

    const renamed = await ctx.db('identity.organization').update({ id: org.id, name: input.name });

    ctx.logger.info(`[identity] organization ${org.name} (${org.id}) renamed ${input.name}`);

    return { organizationId: org.id, name: renamed?.name ?? input.name, was: org.name };
}
