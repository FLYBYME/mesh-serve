import { MeshError, resolveCallerTenant } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { PeopleInput, PeopleOutput } from '../contracts/identity.contract.js';

/**
 * identity.people: the caller's organization's members, by name. The memberships are the scoped
 * collection's (the caller's organization only); a caller who isn't one of them is refused, so an
 * organization's people are told only to its own.
 */
export async function people(
    _input: PeopleInput,
    ctx: IServiceContext
): Promise<PeopleOutput> {
    const userId = ctx.meta?.user?.id ?? '';

    if (userId === '') throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });

    const organizationId = resolveCallerTenant(ctx);
    const memberships = await ctx.db('identity.membership').find({ query: { organizationId }, limit: 10000 });

    if (!memberships.some((m) => m.userId === userId)) throw new MeshError({ message: 'Only the organization\'s own members may see its people.', code: 'FORBIDDEN', status: 403 });

    const found = await Promise.all(memberships.map(async (m) => {
        const user = await ctx.db('identity.user').resolve({ id: m.userId });

        return user === undefined ? undefined : { id: user.id, name: user.displayName, email: user.email, role: m.roleKey };
    }));

    const shown = found.filter((p) => p !== undefined).sort((a, b) => a.name.localeCompare(b.name));

    return { people: shown };
}
