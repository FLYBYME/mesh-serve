import { describe, expect, it } from 'vitest';
import {
    hashToken, MAX_REQUESTS_PER_HOUR, mayRequest, newToken, normalizeEmail, TOKEN_LIFETIME_MS, tokenLink, tokenProblem,
} from '../../../src/identity/methods/userToken.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

describe('one-time links', () => {
    it('a token is random and long; only its hash is kept, and the hash is stable', () => {
        const a = newToken();
        expect(a).not.toBe(newToken());
        expect(a.length).toBeGreaterThanOrEqual(43);
        expect(hashToken(a)).toBe(hashToken(a));
        expect(hashToken(a)).not.toContain(a);
    });

    it('a reset lasts an hour; a verification a week', () => {
        expect(TOKEN_LIFETIME_MS.reset).toBe(3_600_000);
        expect(TOKEN_LIFETIME_MS.verify).toBe(7 * 86_400_000);
    });

    it('works once, for its own purpose, until it expires -- and says the same thing for every refusal', () => {
        const row = { purpose: 'reset', expiresAt: later(60_000) };
        expect(tokenProblem(row, 'reset', NOW)).toBeUndefined();
        const refused = 'That reset link is not valid any more. Ask for a new one.';
        expect(tokenProblem(undefined, 'reset', NOW)).toBe(refused);
        expect(tokenProblem({ ...row, usedAt: NOW }, 'reset', NOW)).toBe(refused);
        expect(tokenProblem(row, 'reset', later(60_000))).toBe(refused);
        expect(tokenProblem({ ...row, purpose: 'verify' }, 'reset', NOW)).toBe(refused);
    });

    it('at most a few requests an hour per address', () => {
        const recent = Array.from({ length: MAX_REQUESTS_PER_HOUR }, (_, i) => new Date(NOW.getTime() - i * 60_000));
        expect(mayRequest(recent, NOW)).toBe(false);
        expect(mayRequest(recent.slice(1), NOW)).toBe(true);
        // An hour later they no longer count.
        expect(mayRequest(recent, later(3_700_000))).toBe(true);
    });

    it('links to the site\'s own page, with the token encoded', () => {
        expect(tokenLink('https://surfdns.net/', 'reset', 'a+b/c')).toBe('https://surfdns.net/reset-password?token=a%2Bb%2Fc');
        expect(tokenLink('https://surfdns.net', 'verify', 'x')).toBe('https://surfdns.net/verify-email?token=x');
    });

    it('addresses compare as typed by a person: case and spaces do not matter', () => {
        expect(normalizeEmail(' Ada@Example.COM ')).toBe('ada@example.com');
    });
});
