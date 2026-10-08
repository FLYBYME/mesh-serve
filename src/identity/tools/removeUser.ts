import { Database, MeshError, type IServiceContext } from '@flybyme/mesh';

import type { UserRemoveInput, UserRemoveOutput } from '../contracts/user.contract.js';
import { membershipCrud } from '../contracts/membership.contract.js';

/**
 * identity.user.remove: what lets the account act goes first -- its memberships (each written with
 * that organization's own scope, as removeOrganization does), sign-in tickets, api tokens and unused
 * links -- then the account. An account that still owns an organization, holds a platform role, or
 * is the caller's own is refused: each would leave something without an owner, or lock someone out.
 */
export async function remove(input: UserRemoveInput, ctx: IServiceContext): Promise<UserRemoveOutput> {
    const user = await ctx.db('identity.user').resolve({ id: input.userId });
    if (user === undefined) throw new MeshError({ message: `No account "${input.userId}".`, code: 'NOT_FOUND', status: 404 });

    if (user.id === ctx.meta?.user?.id) throw new MeshError({ message: 'You cannot remove your own account.', code: 'FORBIDDEN', status: 403 });

    if (user.roles.length > 0) {
        throw new MeshError({ message: `${user.email} holds ${user.roles.join(', ')}: take it away first.`, code: 'CONFLICT', status: 409 });
    }

    const owned = await ctx.db('identity.organization').find({ query: { ownerId: user.id }, limit: 10 });
    if (owned.length > 0) {
        throw new MeshError({ message: `${user.email} owns ${owned.map((o) => o.name).join(', ')}: remove it or hand it over first.`, code: 'CONFLICT', status: 409 });
    }

    // Raw lookup, as in listUsers.ts: identity.membership is scoped by organizationId, and this
    // crosses every organization.
    const db = ctx.broker.getProvider<Database>('database');
    const memberships = await db.repo(membershipCrud.outputSchema, 'identity.membership').find({ query: { userId: user.id } });
    for (const m of memberships) {
        await ctx.db('identity.membership', { user: { id: ctx.meta?.user?.id ?? '', tenant_id: m.organizationId, organizationId: m.organizationId } }).delete({ id: m.id });
    }

    const tickets = await ctx.db('identity.ticket').find({ query: { userId: user.id }, limit: 10_000 });
    for (const t of tickets) await ctx.db('identity.ticket').delete({ id: t.id });

    const apiTokens = await ctx.db('identity.apiToken').find({ query: { userId: user.id }, limit: 10_000 });
    for (const t of apiTokens) await ctx.db('identity.apiToken').delete({ id: t.id });

    const links = await ctx.db('identity.userToken').find({ query: { userId: user.id }, limit: 10_000 });
    for (const l of links) await ctx.db('identity.userToken').delete({ id: l.id });

    await ctx.db('identity.user').delete({ id: user.id });

    ctx.logger.info(`[identity] account ${user.email} (${user.id}) removed, with ${memberships.length} memberships, ${tickets.length} sign-ins, ${apiTokens.length} api tokens, ${links.length} links`);

    return { userId: user.id, email: user.email, memberships: memberships.length, sessions: tickets.length, apiTokens: apiTokens.length, links: links.length };
}
