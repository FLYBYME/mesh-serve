import { MeshError } from '@flybyme/mesh';
import { IdentityService } from '../identity.service.js';
import type { IServiceContext } from '@flybyme/mesh';

import type { IssueInput, IssueOutput } from '../contracts/ticket.contract.js';
import { verifyPassword, issuedToken } from '../methods/hash.js';

const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export async function issueTicket(
    this: IdentityService,
    input: IssueInput,
    ctx: IServiceContext
): Promise<IssueOutput> {
    const user = await ctx.db('identity.user').findOne({ query: { email: input.email } });
    if (user === undefined || !(await verifyPassword(input.password, user.passwordHash ?? ''))) {
        throw new MeshError({ message: 'Invalid email or password.', code: 'INVALID_CREDENTIALS', status: 401 });
    }
    if (user.suspendedAt !== undefined) {
        throw new MeshError({
            message: user.suspendedReason ?? 'Account suspended.',
            code: 'SUSPENDED',
            status: 403,
        });
    }

    const token = issuedToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + TICKET_TTL_MS);
    await ctx.db('identity.ticket').create({
        token,
        userId: user.id,
        roles: user.roles,
        issuedAt,
        expiresAt,
        via: input.via ?? 'login',
    });

    ctx.logger.debug(`issued ticket "${token}" to "${user.id}"`, { id: user.id, token });

    return { token, userId: user.id, expiresAt: expiresAt.getTime() };
}
