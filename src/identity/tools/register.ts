import type { IServiceContext } from '@flybyme/mesh';

import type { RegisterInput, RegisterOutput } from '../contracts/user.contract.js';
import { hashPassword } from '../methods/hash.js';
import { sendFirstVerification } from './userToken.js';
import { normalizeEmail } from '../methods/userToken.js';

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

    ctx.logger.debug(`registered user "${input.email}"`, { id: user.id, email: input.email });

    // A new account proves its address by clicking the link sent to it (identity.user.verify_complete).
    await sendFirstVerification(ctx, user);

    return { userId: user.id };
}
