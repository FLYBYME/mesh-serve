import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { MembershipAssignInput, MembershipAssignOutput } from '../contracts/membership.contract.js';

/**
 * identity.membership.assign: an account's role in one organization -- added, changed, or removed
 * (roleKey null). Written with that organization's own scope (the meta override organization.contract.ts's
 * create hook uses), never the caller's. An organization never loses its last owner.
 */
export async function assignMembership(input: MembershipAssignInput, ctx: IServiceContext): Promise<MembershipAssignOutput> {
    const org = await ctx.db('identity.organization').resolve({ id: input.organizationId });
    if (org === undefined) throw new MeshError({ message: `No organization "${input.organizationId}".`, code: 'NOT_FOUND', status: 404 });
    const user = await ctx.db('identity.user').resolve({ id: input.userId });
    if (user === undefined) throw new MeshError({ message: 'No such account.', code: 'NOT_FOUND', status: 404 });
    if (input.roleKey !== null) {
        const role = await ctx.db('identity.role').findOne({ query: { key: input.roleKey } });
        if (role === undefined || role.scope !== 'organization') {
            throw new MeshError({ message: `"${input.roleKey}" is not an organization role.`, code: 'INVALID_INPUT', status: 422 });
        }
    }

    const memberships = ctx.db('identity.membership', { user: { id: input.userId, tenant_id: org.id, organizationId: org.id } });
    const current = await memberships.findOne({ query: { userId: input.userId } });
    const unchanged = { userId: input.userId, organizationId: org.id, roleKey: current?.roleKey ?? null, changed: false };
    if ((current?.roleKey ?? null) === input.roleKey) return unchanged;

    // Taking the owner role away -- by a change or by removal -- needs another owner left.
    if (current?.roleKey === 'owner') {
        const owners = await memberships.find({ query: { roleKey: 'owner' }, limit: 2 });
        if (owners.filter((m) => m.userId !== input.userId).length === 0) {
            throw new MeshError({ message: `${user.email} is the only owner of ${org.name}: make someone else owner first.`, code: 'FORBIDDEN', status: 403 });
        }
    }

    if (input.roleKey === null) {
        if (current !== undefined) await memberships.delete({ id: current.id });
    } else if (current === undefined) {
        await memberships.create({ userId: input.userId, organizationId: org.id, roleKey: input.roleKey, invitedBy: ctx.meta?.user?.id ?? '', joinedAt: new Date() });
    } else {
        await memberships.update({ id: current.id, roleKey: input.roleKey });
    }
    ctx.logger.info(`[identity] ${user.email} in ${org.name}: ${current?.roleKey ?? 'none'} -> ${input.roleKey ?? 'removed'}`);
    return { userId: input.userId, organizationId: org.id, roleKey: input.roleKey, changed: true };
}
