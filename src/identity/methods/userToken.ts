import crypto from 'node:crypto';

/**
 * One-time links for an account -- pure: resetting a forgotten password, and proving an email
 * address is yours. The paas review (2026-10-01) found no reset at all: a customer who forgot their
 * password could only be rescued by an operator by hand.
 *
 * The link carries a random token; only its hash is stored, so the database alone can never be
 * used to take an account. A token is single-use and expires.
 */
export type UserTokenPurpose = 'reset' | 'verify' | 'invite';

export const TOKEN_LIFETIME_MS: Record<UserTokenPurpose, number> = {
    reset: 60 * 60_000,              // an hour: a reset link is a key to the account
    verify: 7 * 24 * 60 * 60_000,    // a week: proving an address is harmless to leave open longer
    // Three days: a teammate's first password, for an account nobody has used yet -- set like a
    // reset (reset_complete takes either), but people do not read an invitation within the hour.
    invite: 3 * 24 * 60 * 60_000,
};

/** Requests per address per hour, either purpose: enough for a person, useless for flooding someone's inbox. */
export const MAX_REQUESTS_PER_HOUR = 3;

export function newToken(): string {
    return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** Why a token cannot be used, or undefined when it can -- one message for every case, so nothing is learned from it. */
export function tokenProblem(
    row: { readonly purpose: string; readonly expiresAt: Date; readonly usedAt?: Date } | undefined,
    purposes: UserTokenPurpose | readonly UserTokenPurpose[],
    now: Date,
): string | undefined {
    const allowed: readonly string[] = typeof purposes === 'string' ? [purposes] : purposes;
    if (row === undefined || !allowed.includes(row.purpose) || row.usedAt !== undefined || now.getTime() >= row.expiresAt.getTime()) {
        return allowed.includes('reset') ? 'That reset link is not valid any more. Ask for a new one.' : 'That link is not valid any more. Ask for a new one.';
    }
    return undefined;
}

/** Whether another request for this address may be made now, from the times of its recent ones. */
export function mayRequest(recent: readonly Date[], now: Date): boolean {
    const hourAgo = now.getTime() - 60 * 60_000;
    return recent.filter((at) => at.getTime() > hourAgo).length < MAX_REQUESTS_PER_HOUR;
}

/** The link a person clicks: the site's page for it, with the token. */
export function tokenLink(base: string, purpose: UserTokenPurpose, token: string): string {
    const page = { reset: 'reset-password', verify: 'verify-email', invite: 'accept-invite' }[purpose];
    return `${base.replace(/\/+$/, '')}/${page}?token=${encodeURIComponent(token)}`;
}

/** What a reset request always answers, whether or not the address has an account. */
export const RESET_REQUESTED = 'If an account uses that address, a link to set a new password is on its way. It works for an hour.';
