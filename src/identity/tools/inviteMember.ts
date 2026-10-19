import { MeshError, callerUserId, resolveCallerTenant, type IServiceContext } from '@flybyme/mesh';

import type { MembershipInviteInput, MembershipInviteOutput } from '../contracts/membership.contract.js';
import { findUserByEmail } from '../methods/findByEmail.js';
import { normalizeEmail } from '../methods/userToken.js';
import { issue } from './userToken.js';

/** identity.membership.invite -- see contracts/membership.contract.ts. */
export async function invite(input: MembershipInviteInput, ctx: IServiceContext): Promise<MembershipInviteOutput> {
    const organizationId = resolveCallerTenant(ctx);
    const org = await ctx.db('identity.organization').resolve({ id: organizationId });
    if (org === undefined) {
        throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });
    }

    // Only an account that proved its own address mails a stranger's: the invitation names the
    // inviter and the organization, both typed by whoever signed up (10-19, bots signing up).
    const inviter = callerUserId(ctx);
    const by = inviter === undefined ? undefined : await ctx.db('identity.user').resolve({ id: inviter });
    if (by !== undefined && by.emailVerifiedAt === undefined && !by.roles.includes('operator')) {
        throw new MeshError({ message: 'Confirm your email address before inviting anyone: use the link we sent you, or ask for a new one on your account page.', code: 'FORBIDDEN', status: 403 });
    }

    // An existing account, never an agent's; else a new one that can only set its own password.
    let user = await findUserByEmail(ctx, input.email);
    if (user !== undefined && user.kind === 'agent') {
        throw new MeshError({ message: 'That address is an agent account: it cannot be invited.', code: 'FORBIDDEN', status: 403 });
    }

    const invited = user === undefined;
    if (user === undefined) {
        const email = normalizeEmail(input.email);
        user = await ctx.db('identity.user').create({
            email,
            displayName: input.displayName ?? email.split('@')[0] ?? email,
            roles: [],
            provisional: true,
        });
    }

    // Never moves someone already in it: an owner stays owner, an admin is not made a member here.
    const memberships = ctx.db('identity.membership', { user: { id: user.id, tenant_id: org.id, organizationId: org.id } });
    const current = await memberships.findOne({ query: { userId: user.id } });
    if (current !== undefined) {
        throw new MeshError({ message: `${user.email} is already in ${org.name} (${current.roleKey}).`, code: 'CONFLICT', status: 409 });
    }

    await ctx.call('identity.membership.assign', { userId: user.id, organizationId: org.id, roleKey: input.roleKey });

    // A new account's link sets its password; an existing one is told where it was added.
    if (invited) {
        await issue(ctx, user, 'invite', { organization: org.name, by: by?.displayName ?? org.name });
    }
    ctx.logger.info(`[identity] ${user.email} ${invited ? 'invited into' : 'added to'} ${org.name} as ${input.roleKey}`);

    return { userId: user.id, organizationId: org.id, roleKey: input.roleKey, invited };
}
