import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { SetPasswordInput, SetPasswordOutput } from '../contracts/user.contract.js';
import { hashPassword } from '../methods/hash.js';

export async function setPassword(
    input: SetPasswordInput,
    ctx: IServiceContext
): Promise<SetPasswordOutput> {
    const userId = ctx.meta?.user?.id;
    // '' is api.service.ts's own stand-in for "no caller" -- see whoami.ts.
    if (userId === undefined || userId === '') {
        throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const user = await ctx.db('identity.user').resolve({ id: userId });
    if (user === undefined) {
        throw new MeshError({ message: 'No such account.', code: 'UNAUTHENTICATED', status: 401 });
    }
    const passwordHash = await hashPassword(input.password);
    const wasProvisional = user.provisional === true;
    await ctx.db('identity.user').update({
        id: userId,
        passwordHash,
        ...(wasProvisional ? { provisional: false } : {}),
    });

    ctx.logger.debug(`set password for user "${userId}"`, { id: userId, claimed: wasProvisional });

    return { ok: true, claimed: wasProvisional };
}
