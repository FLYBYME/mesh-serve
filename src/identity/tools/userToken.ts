import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type {
    ResetCompleteInput, ResetCompleteOutput, ResetRequestInput, ResetRequestOutput,
    VerifyCompleteInput, VerifyCompleteOutput, VerifyRequestOutput,
} from '../contracts/userToken.contract.js';
import { hashPassword } from '../methods/hash.js';
import { findUserByEmail } from '../methods/findByEmail.js';
import {
    hashToken, mayRequest, newToken, normalizeEmail, RESET_REQUESTED, TOKEN_LIFETIME_MS, tokenLink, tokenProblem,
    type UserTokenPurpose,
} from '../methods/userToken.js';

/** Where links point: the site's own pages for them. */
const LINK_BASE = process.env.IDENTITY_LINK_BASE ?? 'https://surfdns.net';
/**
 * How the link is sent: a contract that sends a templated email, named rather than imported, so
 * mesh-serve never depends on a mail service. It is queued (serve.queue), not called inline: a mail
 * outage is retried with backoff instead of failing the request, and the request never waits on it.
 */
const MAIL_CONTRACT = process.env.IDENTITY_MAIL_CONTRACT ?? 'email.send_template';
/** The organization whose mail sends it; default: the platform's own (slug "platform"). */
const MAIL_TENANT = process.env.IDENTITY_MAIL_TENANT;

const TEMPLATE: Record<UserTokenPurpose, string> = { reset: 'reset_password', verify: 'verify_email' };

async function mailTenant(ctx: IServiceContext): Promise<string | undefined> {
    if (MAIL_TENANT !== undefined && MAIL_TENANT !== '') return MAIL_TENANT;
    const platform = await ctx.db('identity.organization').findOne({ query: { slug: 'platform' } });
    return platform?.id;
}

/** Makes a link for the account and queues the email carrying it. Only the token's hash is kept. */
async function issue(ctx: IServiceContext, user: { id: string; email: string; displayName: string }, purpose: UserTokenPurpose): Promise<boolean> {
    const token = newToken();
    const now = new Date();
    await ctx.db('identity.userToken').create({
        userId: user.id,
        email: normalizeEmail(user.email),
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS[purpose]),
    });
    const tenantId = await mailTenant(ctx);
    if (tenantId === undefined) {
        ctx.logger.warn(`[identity] a ${purpose} link was made for "${user.id}" but there is no organization to send mail as (IDENTITY_MAIL_TENANT)`);
        return false;
    }
    // As the sending organization, explicitly: jobs are scoped by organization, and the caller here
    // is often nobody (registering, a reset request) -- with the caller's meta it was refused.
    await ctx.call('serve.queue.create', {
        tenantId,
        contract: MAIL_CONTRACT,
        payload: { templateKey: TEMPLATE[purpose], to: user.email, vars: { name: user.displayName, url: tokenLink(LINK_BASE, purpose, token) } },
        maxAttempts: 5,
        timeoutMs: 30_000,
    }, { meta: { user: { id: '', tenant_id: tenantId } } });
    return true;
}

/** The address's recent requests, for the rate limit -- any purpose. */
async function recentRequests(ctx: IServiceContext, email: string): Promise<Date[]> {
    const rows = await ctx.db('identity.userToken').find({ query: { email }, sort: '-createdAt', limit: 10 });
    return rows.map((r) => r.createdAt);
}

export async function reset_request(input: ResetRequestInput, ctx: IServiceContext): Promise<ResetRequestOutput> {
    const email = normalizeEmail(input.email);
    // The answer is the same whatever happens below: nothing here may tell a stranger whether an
    // address has an account, or that it is being rate limited.
    const user = await findUserByEmail(ctx, input.email);
    if (user !== undefined && user.suspendedAt === undefined && mayRequest(await recentRequests(ctx, email), new Date())) {
        await issue(ctx, user, 'reset');
    }
    return { message: RESET_REQUESTED };
}

/** The token's row, if it is usable for this purpose now; otherwise one message for every reason. */
async function usable(ctx: IServiceContext, token: string, purpose: UserTokenPurpose) {
    const row = await ctx.db('identity.userToken').findOne({ query: { tokenHash: hashToken(token) } });
    const problem = tokenProblem(row, purpose, new Date());
    if (row === undefined || problem !== undefined) {
        throw new MeshError({ message: problem ?? 'That link is not valid any more.', code: 'INVALID_TOKEN', status: 400 });
    }
    return row;
}

export async function reset_complete(input: ResetCompleteInput, ctx: IServiceContext): Promise<ResetCompleteOutput> {
    const row = await usable(ctx, input.token, 'reset');
    // Used first: a second click on the same link must fail even if this one fails later.
    await ctx.db('identity.userToken').update({ id: row.id, usedAt: new Date() });
    const user = await ctx.db('identity.user').findOne({ query: { id: row.userId } });
    if (user === undefined) throw new MeshError({ message: 'That reset link is not valid any more. Ask for a new one.', code: 'INVALID_TOKEN', status: 400 });

    // A reset proves the person reads the address, so it verifies it too -- and claims a
    // provisional account the same way setting a first password does.
    await ctx.db('identity.user').update({
        id: user.id,
        passwordHash: await hashPassword(input.password),
        ...(user.provisional === true ? { provisional: false } : {}),
        ...(user.emailVerifiedAt === undefined ? { emailVerifiedAt: new Date() } : {}),
    });

    // Whoever had the old password may have a session: every one ends.
    const tickets = await ctx.db('identity.ticket').find({ query: { userId: user.id }, limit: 1000 });
    let signedOutSessions = 0;
    for (const ticket of tickets) {
        if (ticket.revokedAt !== undefined) continue;
        await ctx.db('identity.ticket').update({ id: ticket.id, revokedAt: new Date(), revokedReason: 'password reset' });
        signedOutSessions++;
    }
    if (signedOutSessions > 0) ctx.emit('identity.user.signed_out', { userId: user.id });
    ctx.logger.info(`[identity] password reset for "${user.id}"; ${signedOutSessions} sessions ended`);
    return { ok: true, signedOutSessions };
}

export async function verify_request(_input: Record<string, never>, ctx: IServiceContext): Promise<VerifyRequestOutput> {
    const userId = ctx.meta?.user?.id;
    if (userId === undefined || userId === '') throw new MeshError({ message: 'No caller.', code: 'UNAUTHENTICATED', status: 401 });
    const user = await ctx.db('identity.user').findOne({ query: { id: userId } });
    if (user === undefined) throw new MeshError({ message: 'No such account.', code: 'UNAUTHENTICATED', status: 401 });
    if (user.emailVerifiedAt !== undefined) return { sent: false, alreadyVerified: true };
    if (!mayRequest(await recentRequests(ctx, normalizeEmail(user.email)), new Date())) {
        throw new MeshError({ message: 'A link was sent a few times already this hour. Check your inbox, or try again later.', code: 'RATE_LIMITED', status: 429 });
    }
    return { sent: await issue(ctx, user, 'verify'), alreadyVerified: false };
}

export async function verify_complete(input: VerifyCompleteInput, ctx: IServiceContext): Promise<VerifyCompleteOutput> {
    const row = await usable(ctx, input.token, 'verify');
    await ctx.db('identity.userToken').update({ id: row.id, usedAt: new Date() });
    const user = await ctx.db('identity.user').findOne({ query: { id: row.userId } });
    // The address must still be the account's: a link for an old address proves nothing about the new one.
    if (user === undefined || normalizeEmail(user.email) !== row.email) {
        throw new MeshError({ message: 'That link is not valid any more. Ask for a new one.', code: 'INVALID_TOKEN', status: 400 });
    }
    if (user.emailVerifiedAt === undefined) await ctx.db('identity.user').update({ id: user.id, emailVerifiedAt: new Date() });
    return { ok: true, email: user.email };
}

/** Sends the first verification link to a new account (register.ts); a failure never fails registering. */
export async function sendFirstVerification(ctx: IServiceContext, user: { id: string; email: string; displayName: string }): Promise<void> {
    await issue(ctx, user, 'verify').catch((err: unknown) => {
        ctx.logger.warn(`[identity] verification link for "${user.id}" not queued: ${err instanceof Error ? err.message : String(err)}`);
    });
}
