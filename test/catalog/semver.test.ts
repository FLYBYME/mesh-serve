/**
 * Range resolution.
 *
 * The most consequential pure function in the repository: it decides what code a hostname runs. Two
 * cases carry most of the weight — **the 0.x caret rule**, because the kernel is 0.2.0 and that is
 * the live case rather than a corner one, and **prereleases staying out of ranges**, because getting
 * that wrong ships a release candidate to every site tracking `^1.0`.
 */

import { describe, expect, it } from 'vitest';

import { boundsOf, compare, highest, parse, satisfies } from '../../src/catalog/methods/semver.js';

describe('parsing', () => {
    it('reads a plain version', () => {
        expect(parse('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    });

    it('reads a prerelease, splitting numeric identifiers', () => {
        expect(parse('1.0.0-beta.2')?.prerelease).toEqual(['beta', 2]);
    });

    it('ignores build metadata, which is not part of identity', () => {
        expect(parse('1.2.3+build.7')).toEqual(parse('1.2.3'));
    });

    it('returns undefined rather than throwing, so one bad row cannot fail a query', () => {
        for (const bad of ['1.2', 'v1.2.3', 'latest', '', '1.2.3.4']) {
            expect(parse(bad)).toBeUndefined();
        }
    });
});

describe('ordering', () => {
    const order = (a: string, b: string) => compare(parse(a)!, parse(b)!);

    it('compares by major, then minor, then patch', () => {
        expect(order('2.0.0', '1.9.9')).toBeGreaterThan(0);
        expect(order('1.2.0', '1.1.9')).toBeGreaterThan(0);
        expect(order('1.1.2', '1.1.1')).toBeGreaterThan(0);
    });

    it('ranks a release above its own prereleases', () => {
        expect(order('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    });

    it('compares prerelease identifiers numerically where they are numbers', () => {
        // The string comparison this replaces puts 'beta.10' below 'beta.9'.
        expect(order('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0);
    });

    it('ranks a numeric identifier below an alphanumeric one', () => {
        expect(order('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    });

    it('ranks a longer prerelease above a shorter prefix of it', () => {
        expect(order('1.0.0-beta.1', '1.0.0-beta')).toBeGreaterThan(0);
    });
});

describe('the caret, and the 0.x rule', () => {
    it('allows anything below the next major, above 0', () => {
        expect(satisfies('1.9.9', '^1.2.0')).toBe(true);
        expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
        expect(satisfies('1.1.9', '^1.2.0')).toBe(false);
    });

    it('allows only below the next MINOR at 0.x', () => {
        // The live case: mesh-web is 0.2.0. A leading zero means the API is not stable, so a minor
        // bump may break — and `^0.2` matching 0.3.0 would silently move every site onto it.
        expect(satisfies('0.2.9', '^0.2')).toBe(true);
        expect(satisfies('0.3.0', '^0.2')).toBe(false);
        expect(satisfies('0.2.0', '^0.2')).toBe(true);
        expect(satisfies('0.1.9', '^0.2')).toBe(false);
    });

    it('allows only that exact patch at 0.0.x', () => {
        expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
        expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    });

    it('accepts a partial range, which is what everything here writes', () => {
        expect(satisfies('1.4.2', '^1.4')).toBe(true);
        expect(satisfies('1.4.2', '^1')).toBe(true);
    });
});

describe('the other forms', () => {
    it('~ allows patches only', () => {
        expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
        expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    });

    it('* takes any release', () => {
        expect(satisfies('7.0.1', '*')).toBe(true);
    });

    it('>= is unbounded above', () => {
        expect(satisfies('9.9.9', '>=1.0.0')).toBe(true);
        expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);
    });

    it('an exact range matches exactly', () => {
        expect(satisfies('1.2.3', '1.2.3')).toBe(true);
        expect(satisfies('1.2.4', '1.2.3')).toBe(false);
    });

    it('refuses a range it does not implement, rather than matching nothing quietly', () => {
        // The distinction that matters: `undefined` lets a caller say "that is not a range I
        // understand", which is a different report from "nothing is published".
        expect(boundsOf('1.x')).toBeUndefined();
        expect(boundsOf('>1.0.0 <2.0.0')).toBeUndefined();
        expect(boundsOf('^1.4')).toBeDefined();
    });
});

describe('prereleases stay out of ranges', () => {
    it('is not picked up by a caret', () => {
        // Otherwise publishing a release candidate ships it to every site tracking the range.
        expect(satisfies('1.1.0-rc.1', '^1.0')).toBe(false);
    });

    it('is not picked up by *', () => {
        expect(satisfies('2.0.0-beta', '*')).toBe(false);
    });

    it('is reachable by naming it exactly', () => {
        expect(satisfies('1.1.0-rc.1', '1.1.0-rc.1')).toBe(true);
    });
});

describe('choosing from what is published', () => {
    const published = ['1.0.0', '1.4.0', '1.4.2', '1.3.0', '2.0.0', '1.5.0-rc.1'];

    it('takes the newest match, not the first', () => {
        // A database returns rows in whatever order it chose; resolution must not depend on that.
        expect(highest(published, '^1.0')).toBe('1.4.2');
    });

    it('does not cross the caret boundary', () => {
        expect(highest(published, '^1.0')).not.toBe('2.0.0');
    });

    it('skips the release candidate', () => {
        expect(highest(published, '^1.0')).not.toBe('1.5.0-rc.1');
    });

    it('is undefined when nothing satisfies', () => {
        expect(highest(published, '^3.0')).toBeUndefined();
    });

    it('ignores rows it cannot parse', () => {
        expect(highest([...published, 'nightly'], '*')).toBe('2.0.0');
    });
});
