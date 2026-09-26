import { describe, expect, it } from 'vitest';
import { claimStart, releaseStart } from '../../../src/catalog/methods/services.js';

/**
 * A start is marked running only once loaded -- ~40 s for surfdns-compute -- and a reconcile pass in
 * that window saw the part "not running" and could start it again into the same process.
 */
describe('claimStart', () => {
    it('refuses a second start of the same part on the same node while the first is under way', () => {
        expect(claimStart('surf', 'p1')).toBe(true);
        expect(claimStart('surf', 'p1')).toBe(false);
        releaseStart('surf', 'p1');
        expect(claimStart('surf', 'p1')).toBe(true);
        releaseStart('surf', 'p1');
    });

    it('is per node and per part', () => {
        expect(claimStart('surf', 'p2')).toBe(true);
        expect(claimStart('edge1', 'p2')).toBe(true);
        expect(claimStart('surf', 'p3')).toBe(true);
        for (const [n, p] of [['surf', 'p2'], ['edge1', 'p2'], ['surf', 'p3']] as const) releaseStart(n, p);
    });
});
