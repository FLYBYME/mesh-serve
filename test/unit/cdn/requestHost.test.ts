import { describe, expect, it } from 'vitest';
import { requestHost } from '../../../src/cdn/gateway.js';

/**
 * A page through a real route (surfdns-proxy) arrives with Host set to this node's own upstream
 * address; the name the client typed is in x-forwarded-host. Reading Host alone answered
 * https://surfdns.net/ with "No site for 10.42.0.4".
 */
describe('cdn requestHost', () => {
    it('prefers x-forwarded-host over Host, when a proxy set both', () => {
        expect(requestHost({ host: '10.42.0.4:3123', 'x-forwarded-host': 'surfdns.net' })).toBe('surfdns.net');
    });

    it('falls back to Host for a direct, unproxied hit', () => {
        expect(requestHost({ host: 'surfdns.net:3123' })).toBe('surfdns.net:3123');
    });

    it('takes the first value when x-forwarded-host arrives as an array', () => {
        expect(requestHost({ host: '10.42.0.4:3123', 'x-forwarded-host': ['surfdns.net', 'other.example.com'] })).toBe('surfdns.net');
    });

    it('is undefined with neither header', () => {
        expect(requestHost({})).toBeUndefined();
    });
});
