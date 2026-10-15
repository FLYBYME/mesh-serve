import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { IssueInput, IssueOutput } from '../contracts/apiToken.contract.js';
import { hashToken, issuedToken } from '../methods/hash.js';
import { expandRoles, inOrganization, resolveEffectiveRoleKeys } from '../methods/roles.js';
import { tokenOwner } from '../methods/tokenOwner.js';

/**
 * Mints an api token -- for the caller, or (operator only) for another account -- carrying only
 * roles that account already holds. The api gateway re-resolves an account's real roles on every
 * gated call, but a token's own `roles` are what other services see (surfdns-gitserver authorizes
 * pushes from them), so a token must never claim more than its account has.
 *
 * The plaintext token exists only in the response. It used to be written to the debug log too.
 */
export async function issueApiToken(
    input: IssueInput,
    ctx: IServiceContext
): Promise<IssueOutput> {
    const userId = await tokenOwner(ctx, input.userId);

    const user = await ctx.db('identity.user').resolve({ id: userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'NOT_FOUND', status: 404 });
    }

    if (input.organizationId !== undefined) {
        const membership = await ctx.db('identity.membership', inOrganization(ctx, input.organizationId))
            .findOne({ query: { userId, organizationId: input.organizationId } });
        if (membership === undefined) {
            throw new MeshError({
                message: 'A token can only be scoped to an organization its account belongs to.',
                code: 'FORBIDDEN',
                status: 403,
            });
        }
    }

    // Held with what they include: an owner holds admin and member too, and may want a token with
    // less than all of it (a push token for a client's own repo, 10-15). Unexpanded, an owner was
    // refused a member token -- a narrower one than the account they hold.
    const roles = input.roles ?? [];
    const held = await expandRoles(await resolveEffectiveRoleKeys(userId, input.organizationId, ctx), ctx);
    const notHeld = roles.filter((role) => !held.has(role));
    if (notHeld.length > 0) {
        throw new MeshError({
            message: `A token can only carry roles its account holds; not held: ${notHeld.join(', ')}.`,
            code: 'FORBIDDEN',
            status: 403,
        });
    }

    const token = issuedToken();
    const expiresAt = input.expiresInMs === undefined ? undefined : new Date(Date.now() + input.expiresInMs);
    await ctx.db('identity.apiToken').create({
        tokenHash: hashToken(token),
        name: input.name,
        userId,
        roles,
        ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    ctx.logger.debug(`issued api token "${input.name}" for "${userId}"`, { id: userId, name: input.name });

    return {
        token,
        name: input.name,
        userId,
        roles,
        ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.getTime() }),
    };
}
