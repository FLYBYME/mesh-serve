import { callerUserId, MeshError, type IServiceContext } from '@flybyme/mesh';

import type { MembershipAssignInput, MembershipAssignOutput } from '../contracts/membership.contract.js';
import { inOrganization } from '../methods/roles.js';

/**
 * identity.membership.assign: an account's role in one organization -- added, changed, or removed
 * (roleKey null). Written with that organization's own scope (the meta override organization.contract.ts's
 * create hook uses), never the caller's. An organization never loses its last owner.
 *
 * The caller must hold admin or owner in input.organizationId (an operator may act anywhere);
 * and only an owner may give or take the owner role.
 */
export async function assignMembership(input: MembershipAssignInput, ctx: IServiceContext): Promise<MembershipAssignOutput> {
    const org = await ctx.db('identity.organization').resolve({ id: input.organizationId });
    if (org === undefined) {
        throw new MeshError({ message: `No organization "${input.organizationId}".`, code: 'NOT_FOUND', status: 404 });
    }

    const user = await ctx.db('identity.user').resolve({ id: input.userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'NOT_FOUND', status: 404 });
    }

    if (input.roleKey !== null) {
        const role = await ctx.db('identity.role').findOne({ query: { key: input.roleKey } });
        if (role === undefined || role.scope !== 'organization') {
            throw new MeshError({ message: `"${input.roleKey}" is not an organization role.`, code: 'INVALID_INPUT', status: 422 });
        }
    }

    const memberships = ctx.db('identity.membership', { user: { id: input.userId, tenant_id: org.id, organizationId: org.id } });
    const current = await memberships.findOne({ query: { userId: input.userId } });

    const callerId = callerUserId(ctx);
    const callerRoles = ctx.meta?.user?.roles ?? [];
    let isOperator = callerRoles.includes('operator');
    if (!isOperator && callerId !== undefined) {
        const callerUser = await ctx.db('identity.user').resolve({ id: callerId });
        if (callerUser !== undefined && callerUser.roles.includes('operator')) {
            isOperator = true;
        }
    }

    if (!isOperator) {
        if (callerId === undefined) {
            throw new MeshError({ message: 'Authentication required.', code: 'UNAUTHORIZED', status: 401 });
        }

        const callerScope = inOrganization(ctx, org.id);
        const callerMembership = await ctx.db('identity.membership', callerScope).findOne({ query: { userId: callerId, organizationId: org.id } });
        const callerRoleKey = callerMembership?.roleKey;
        const isCallerOwner = callerRoleKey === 'owner';
        const isCallerAdmin = callerRoleKey === 'admin';

        if (!isCallerOwner && !isCallerAdmin) {
            throw new MeshError({
                message: `You must be an admin or owner of ${org.name} to assign memberships.`,
                code: 'FORBIDDEN',
                status: 403,
            });
        }

        if (!isCallerOwner) {
            if (input.roleKey === 'owner' || current?.roleKey === 'owner') {
                throw new MeshError({
                    message: `Only an owner of ${org.name} may give or take the owner role.`,
                    code: 'FORBIDDEN',
                    status: 403,
                });
            }
        }
    }

    const unchanged = { userId: input.userId, organizationId: org.id, roleKey: current?.roleKey ?? null, changed: false };
    if ((current?.roleKey ?? null) === input.roleKey) {
        return unchanged;
    }

    // Taking the owner role away -- by a change or by removal -- needs another owner left.
    if (current?.roleKey === 'owner') {
        const owners = await memberships.find({ query: { roleKey: 'owner' }, limit: 2 });
        if (owners.filter((m) => m.userId !== input.userId).length === 0) {
            throw new MeshError({ message: `${user.email} is the only owner of ${org.name}: make someone else owner first.`, code: 'FORBIDDEN', status: 403 });
        }
    }

    if (input.roleKey === null) {
        if (current !== undefined) {
            await memberships.delete({ id: current.id });
        }
    } else if (current === undefined) {
        const invitedBy = ctx.meta?.user?.id ?? '';
        await memberships.create({ userId: input.userId, organizationId: org.id, roleKey: input.roleKey, invitedBy, joinedAt: new Date() });
    } else {
        await memberships.update({ id: current.id, roleKey: input.roleKey });
    }

    ctx.logger.info(`[identity] ${user.email} in ${org.name}: ${current?.roleKey ?? 'none'} -> ${input.roleKey ?? 'removed'}`);

    return { userId: input.userId, organizationId: org.id, roleKey: input.roleKey, changed: true };
}
