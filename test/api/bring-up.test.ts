/**
 * `rangeFor` — the range a rolling release follows after a version is minted.
 *
 * Small enough to look obvious and load-bearing enough to test: it is what decides whether a
 * freshly brought-up cluster can compose at all. The bug it exists because of was a list of ranges
 * written by hand against a catalog that already had history — every one of them matched nothing on
 * an empty database, so seven successful builds were followed by seven "nothing satisfies" refusals.
 */

import { describe, expect, it } from 'vitest';

import { rangeFor } from '../../src/bring-up.js';

describe('the range a minted version becomes', () => {
    it('carets the major and minor, so patches roll and the next minor does not', () => {
        expect(rangeFor('0.1.0')).toBe('^0.1');
        expect(rangeFor('1.4.2')).toBe('^1.4');
    });

    it('is what a fresh catalog actually mints', () => {
        // `nextVersion([])` is `0.1.0` — a first automated build has not earned a 1.0.0 — so this
        // is the case every first bring-up takes, and the one the hand-written list got wrong.
        expect(rangeFor('0.1.0')).toBe('^0.1');
    });

    it('does not invent a shape for something it cannot parse', () => {
        // A label the catalog accepted but this cannot split. Better a range that matches exactly
        // that version than one built from half a string.
        expect(rangeFor('nightly')).toBe('^nightly');
    });
});
