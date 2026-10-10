import { describe, expect, it } from 'vitest';
import { clientAddress, FormLimiter, formTiming } from '../../../src/api/methods/formLimit.js';

describe('FormLimiter: public forms per client address', () => {
    it('lets an address call a form up to its limit in an hour, then refuses it until the hour passes', () => {
        let now = 0;
        const limiter = new FormLimiter({ 'identity.user.register': 2 }, () => now);

        expect(limiter.allow('identity.user.register', '1.2.3.4')).toBe(true);
        expect(limiter.allow('identity.user.register', '1.2.3.4')).toBe(true);
        expect(limiter.allow('identity.user.register', '1.2.3.4')).toBe(false);
        // Another address is its own.
        expect(limiter.allow('identity.user.register', '5.6.7.8')).toBe(true);

        now = 3600_001;
        expect(limiter.allow('identity.user.register', '1.2.3.4')).toBe(true);
    });

    it('never limits a call that is not a public form', () => {
        const limiter = new FormLimiter({ 'identity.user.register': 1 }, () => 0);
        for (let i = 0; i < 100; i++) expect(limiter.allow('dns.record_add', '1.2.3.4')).toBe(true);
    });

    it('remembers a bounded number of addresses', () => {
        const limiter = new FormLimiter({ 'email.contact': 1 }, () => 0, 2);
        limiter.allow('email.contact', 'a');
        limiter.allow('email.contact', 'b');
        limiter.allow('email.contact', 'c');
        // 'a' was the oldest of three: forgotten, so it may send again.
        expect(limiter.allow('email.contact', 'a')).toBe(true);
    });
});

describe('formTiming: a public form sent within seconds of being shown', () => {
    it('refuses a form sent under 3 s, or a measure that is not a number; takes the measure out', () => {
        expect(formTiming('email.contact', { name: 'a', shownForMs: 800 })).toEqual({ tooFast: true, unmeasured: false, input: { name: 'a' } });
        expect(formTiming('identity.user.register', { email: 'x@y.z', shownForMs: '9000' })).toEqual({ tooFast: true, unmeasured: false, input: { email: 'x@y.z' } });
        expect(formTiming('identity.user.reset_request', { email: 'x@y.z', shownForMs: 12_000 })).toEqual({ tooFast: false, unmeasured: false, input: { email: 'x@y.z' } });
    });

    it('a form with no measure (a bot posting without the page): said, and refused once the measure is required', () => {
        expect(formTiming('email.contact', { name: 'a' }, false)).toEqual({ tooFast: false, unmeasured: true, input: { name: 'a' } });
        expect(formTiming('email.contact', { name: 'a' }, true)).toEqual({ tooFast: true, unmeasured: true, input: { name: 'a' } });
    });

    it('never looks at a call that is not a public form, and leaves its input as it is', () => {
        expect(formTiming('dns.record_add', { name: 'www', shownForMs: 1 })).toEqual({ tooFast: false, unmeasured: false, input: { name: 'www', shownForMs: 1 } });
    });
});

describe('clientAddress', () => {
    it('is the proxy\'s X-Forwarded-For (its last entry), else the socket\'s', () => {
        expect(clientAddress('203.0.113.9', '10.10.0.5')).toBe('203.0.113.9');
        expect(clientAddress('6.6.6.6, 203.0.113.9', '10.10.0.5')).toBe('203.0.113.9');
        expect(clientAddress(undefined, '10.10.0.5')).toBe('10.10.0.5');
        expect(clientAddress(undefined, undefined)).toBe('unknown');
    });
});
