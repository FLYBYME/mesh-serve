import { randomBytes } from 'node:crypto';
import { MeshError, type IServiceContext } from '@flybyme/mesh';

import type { RegisterInput, RegisterOutput } from '../contracts/user.contract.js';
import { hashPassword } from '../methods/hash.js';
import { sendFirstVerification } from './userToken.js';
import { normalizeEmail } from '../methods/userToken.js';

/**
 * A slug for a new account's own organization: its name in lower case letters, digits and dashes,
 * plus a random tail so two "Ada"s never collide (slugs are unique across the platform).
 */
export function organizationSlug(displayName: string): string {
    const base = displayName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'org';
    return `${base}-${randomBytes(3).toString('hex')}`;
}

export async function register(
    input: RegisterInput,
    ctx: IServiceContext
): Promise<RegisterOutput> {
    const passwordHash = await hashPassword(input.password);
    // Lower case, so an address matches however it is typed later (methods/findByEmail.ts) and
    // "Ada@" and "ada@" can never be two accounts.
    const user = await ctx.db('identity.user').create({
        email: normalizeEmail(input.email),
        displayName: input.displayName,
        passwordHash,
        roles: [],
    });

    // Every account starts with its own organization, owner of it (organization.contract.ts's
    // create hook adds the membership): a customer is an organization, and what it may do comes from
    // its plan, not from existing -- one with no plan can create nothing (owner, 2026-10-02). Without
    // it a new account could sign in but not buy: checkout bills the caller's organization.
    // Account and organization come together or not at all: an account left without one could
    // never register again (its address is taken).
    try {
        await ctx.call('identity.organization.create', {
            slug: organizationSlug(input.displayName),
            name: `${input.displayName}'s organization`,
            ownerId: user.id,
        });
    } catch (err) {
        await ctx.db('identity.user').delete({ id: user.id }).catch(() => undefined);
        ctx.logger.error(`[identity] no organization for new account "${input.email}"; the account was removed`, err);
        throw new MeshError({ message: 'The account could not be set up. Nothing was kept: try again.', code: 'REGISTER_FAILED', status: 500 });
    }

    ctx.logger.debug(`registered user "${input.email}"`, { id: user.id, email: input.email });

    // A new account proves its address by clicking the link sent to it (identity.user.verify_complete).
    await sendFirstVerification(ctx, user);

    return { userId: user.id };
}
