import { describe, expect, it } from 'vitest';
import { clientAddress, FormLimiter } from '../../../src/api/methods/formLimit.js';

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

describe('clientAddress', () => {
    it('is the proxy\'s X-Forwarded-For (its last entry), else the socket\'s', () => {
        expect(clientAddress('203.0.113.9', '10.10.0.5')).toBe('203.0.113.9');
        expect(clientAddress('6.6.6.6, 203.0.113.9', '10.10.0.5')).toBe('203.0.113.9');
        expect(clientAddress(undefined, '10.10.0.5')).toBe('10.10.0.5');
        expect(clientAddress(undefined, undefined)).toBe('unknown');
    });
});
