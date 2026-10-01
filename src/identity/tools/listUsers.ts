import { Database } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { ListUsersInput, ListUsersOutput } from '../contracts/user.contract.js';
import { membershipCrud } from '../contracts/membership.contract.js';

const PAGE = 500;

export async function list(
    _input: ListUsersInput,
    ctx: IServiceContext
): Promise<ListUsersOutput> {
    const users = [];
    for (let offset = 0; ; offset += PAGE) {
        const page = await ctx.db('identity.user').find({ query: {}, sort: 'createdAt', limit: PAGE, offset });
        users.push(...page);
        if (page.length < PAGE) break;
    }

    // Raw lookups, as in whoami.ts: identity.membership is scoped by organizationId, and this view
    // crosses every organization.
    const db = ctx.broker.getProvider<Database>('database');
    const memberships = await db.repo(membershipCrud.outputSchema, 'identity.membership').find({ query: {} });
    const orgIds = [...new Set(memberships.map((m) => m.organizationId))];
    const names = new Map<string, string>();
    await Promise.all(orgIds.map(async (id) => {
        const org = await ctx.db('identity.organization').resolve({ id });
        names.set(id, org?.name ?? 'unknown');
    }));

    return {
        users: users.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            roles: u.roles,
            provisional: u.provisional === true,
            ...(u.suspendedAt !== undefined ? { suspendedAt: u.suspendedAt } : {}),
            ...(u.createdAt !== undefined ? { createdAt: u.createdAt } : {}),
            organizations: memberships
                .filter((m) => m.userId === u.id)
                .map((m) => ({ organizationId: m.organizationId, name: names.get(m.organizationId) ?? 'unknown', roleKey: m.roleKey })),
        })),
    };
}
