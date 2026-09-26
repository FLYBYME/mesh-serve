import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { SetPasswordInput, SetPasswordOutput } from '../contracts/user.contract.js';
import { hashPassword, verifyPassword } from '../methods/hash.js';

export async function setPassword(
    input: SetPasswordInput,
    ctx: IServiceContext
): Promise<SetPasswordOutput> {
    const userId = ctx.meta?.user?.id;
    // '' is api.service.ts's own stand-in for "no caller" -- see whoami.ts.
    if (userId === undefined || userId === '') {
        throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const user = await ctx.db('identity.user').findOne({ query: { id: userId } });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const wasProvisional = user.provisional === true;
    // A ticket alone is not enough to replace a password that exists: a stolen ticket would
    // otherwise lock the owner out for good. A provisional account has none yet -- setting the
    // first one is how it is claimed.
    if (!wasProvisional && user.passwordHash !== undefined && user.passwordHash !== '') {
        if (input.currentPassword === undefined || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
            throw new MeshError({ message: 'Your current password is required, and did not match.', code: 'INVALID_CREDENTIALS', status: 401 });
        }
    }
    const passwordHash = await hashPassword(input.password);
    await ctx.db('identity.user').update({
        id: userId,
        passwordHash,
        ...(wasProvisional ? { provisional: false } : {}),
    });

    ctx.logger.debug(`set password for user "${userId}"`, { id: userId, claimed: wasProvisional });

    return { ok: true, claimed: wasProvisional };
}
