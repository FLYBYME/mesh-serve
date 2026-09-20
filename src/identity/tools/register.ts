import type { IServiceContext } from '@flybyme/mesh';

import type { RegisterInput, RegisterOutput } from '../contracts/user.contract.js';
import { hashPassword } from '../methods/hash.js';

export async function register(
    input: RegisterInput,
    ctx: IServiceContext
): Promise<RegisterOutput> {
    const passwordHash = await hashPassword(input.password);
    const user = await ctx.db('identity.user').create({
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        roles: [],
    });

    ctx.logger.debug(`registered user "${input.email}"`, { id: user.id, email: input.email });

    return { userId: user.id };
}
