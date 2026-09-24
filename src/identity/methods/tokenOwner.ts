import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { resolveEffectiveRoleKeys } from './roles.js';

/** The cluster-wide role allowed to manage other accounts' api tokens (builtinRoles.ts). */
export const TOKEN_ADMIN_ROLE = 'operator';

/** The authenticated caller's user id, or a 401. '' is the api gateway's own "no caller" (see whoami). */
export function callerId(ctx: IServiceContext): string {
    const id = ctx.meta?.user?.id;
    if (typeof id !== 'string' || id === '') {
        throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    }
    return id;
}

/**
 * Whose api tokens this call is about: the caller's own, unless it names another account -- which
 * only a holder of the global operator role may do. Without this, identity.apiToken.issue minted a
 * token for any userId it was handed, and a token acts as its account: anyone who could reach it
 * could become anyone.
 */
export async function tokenOwner(ctx: IServiceContext, requestedUserId: string | undefined): Promise<string> {
    const caller = callerId(ctx);
    if (requestedUserId === undefined || requestedUserId === caller) return caller;

    const callerRoles = await resolveEffectiveRoleKeys(caller, undefined, ctx);
    if (!callerRoles.has(TOKEN_ADMIN_ROLE)) {
        throw new MeshError({
            message: `Only the ${TOKEN_ADMIN_ROLE} role may manage another account's api tokens.`,
            code: 'FORBIDDEN',
            status: 403,
        });
    }
    return requestedUserId;
}
