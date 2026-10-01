import type { IServiceContext } from '@flybyme/mesh';

import { normalizeEmail } from './userToken.js';

/**
 * An account by its address, however a person types it. Addresses are stored lower case
 * (register.ts, 2026-10-01); before that one was stored as typed, so "Ada@Example.com" could not
 * sign in as "ada@example.com" and a password reset for it found nothing. The lower-case form is
 * tried first, then the address exactly as given, for an account made before.
 */
export async function findUserByEmail(ctx: IServiceContext, email: string) {
    const normalized = normalizeEmail(email);
    const found = await ctx.db('identity.user').findOne({ query: { email: normalized } });
    if (found !== undefined || email === normalized) return found;
    return ctx.db('identity.user').findOne({ query: { email: email.trim() } });
}
