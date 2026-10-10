import { callApi } from './apiClient.js';
import { patchSession, type Session } from './session.js';

/** Renew a ticket with less than this left (owner, 10-10: "a few hours before the 24h"). */
export const RENEW_WITHIN_MS = 4 * 60 * 60 * 1000;

const RENEW_CALL = { key: 'identity.ticket.renew', method: 'POST', path: '/identity/ticket/renew' };

/**
 * The session, its ticket renewed first when it ends within four hours (identity.ticket.renew):
 * so a CLI in use never lapses. A ticket that cannot be renewed -- 30 days past its password, or an
 * api that does not expose renew yet -- is kept as it is, to run out and ask for `login`.
 */
export async function renewIfDue(apiUrl: string, session: Session): Promise<Session> {
    if (session.token === undefined || session.expiresAt === undefined) return session;

    const left = session.expiresAt - Date.now();
    if (left <= 0 || left > RENEW_WITHIN_MS) return session;

    let renewed: unknown;
    try {
        renewed = await callApi(apiUrl, RENEW_CALL, { token: session.token });
    } catch {
        return session;
    }
    if (!isIssued(renewed)) return session;

    return patchSession({ token: renewed.token, expiresAt: renewed.expiresAt });
}

function isIssued(value: unknown): value is { token: string; expiresAt: number } {
    return typeof value === 'object' && value !== null
        && 'token' in value && typeof value.token === 'string'
        && 'expiresAt' in value && typeof value.expiresAt === 'number';
}
