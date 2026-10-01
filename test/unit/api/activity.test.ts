import { describe, expect, it } from 'vitest';
import { MAX_SUMMARY, outcomeOf, shouldRecord, summarizeInput } from '../../../src/api/methods/activity.js';

describe('the activity log keeps', () => {
    it('every call that changes something, whatever happened to it, and every refusal -- not reads', () => {
        expect(shouldRecord({ destructive: true }, 'ok')).toBe(true);
        expect(shouldRecord({ destructive: true }, 'failed')).toBe(true);
        expect(shouldRecord({ destructive: true }, 'held')).toBe(true);
        expect(shouldRecord({ destructive: false }, 'refused')).toBe(true);
        expect(shouldRecord({ destructive: false }, 'ok')).toBe(false);
        expect(shouldRecord({}, 'failed')).toBe(false);
    });

    it('reads how a call came out from its status', () => {
        expect([200, 202, 401, 403, 404, 422, 500, 503].map(outcomeOf)).toEqual(['ok', 'held', 'refused', 'refused', 'failed', 'failed', 'failed', 'failed']);
    });
});

describe('an input, as it is written down', () => {
    it('never keeps a secret, however it is named or nested', () => {
        const text = summarizeInput({
            email: 'ada@example.com', password: 'hunter22', currentPassword: 'old', token: 't', apiKey: 'k',
            nested: { privateKey: 'pk', credentialRef: 'c', passwordHash: 'h', ok: 'kept' },
        });
        for (const secret of ['hunter22', '"old"', '"t"', '"k"', '"pk"', '"c"', '"h"']) expect(text).not.toContain(secret);
        expect(text).toContain('ada@example.com');
        expect(text).toContain('"ok":"kept"');
        expect(text).toContain('[redacted]');
    });

    it('cuts long values and lists, and the whole, to a bounded size', () => {
        const text = summarizeInput({ body: 'x'.repeat(5000), list: Array.from({ length: 100 }, (_, i) => i) });
        expect(text).toContain('…(5000)');
        expect(text).toContain('…(100 items)');
        expect(summarizeInput({ a: Array.from({ length: 20 }, () => 'y'.repeat(200)), b: Array.from({ length: 20 }, () => 'z'.repeat(200)) }).length)
            .toBeLessThanOrEqual(MAX_SUMMARY + 1);
    });

    it('nothing at all when the call never got as far as its input', () => {
        expect(summarizeInput(undefined)).toBe('');
    });
});
