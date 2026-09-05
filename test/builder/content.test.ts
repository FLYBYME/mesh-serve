/**
 * Content addressing.
 *
 * The tests worth having here are the ones about *identity*: two things that mean the same must hash
 * the same, and two things that differ must not. A hash that is merely "a hash" would pass a test
 * that checked it was 32 characters long and still break every cache in the system.
 */

import { describe, expect, it } from 'vitest';

import {
    artifactDigest, artifactSlug, canonical, contentTypeOf, digestOf, inputHash,
} from '../../src/builder/methods/content.js';
import type { ArtifactFile } from '../../src/builder/schema/artifact.js';

const COMMIT = 'a'.repeat(40);

const file = (path: string, digest: string): ArtifactFile =>
    ({ path, digest, size: 1, contentType: 'text/javascript; charset=utf-8' });

describe('canonical form', () => {
    it('does not depend on key order', () => {
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    });

    it('does depend on values', () => {
        expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
    });

    it('drops undefined, so an absent field and an explicit undefined agree', () => {
        expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
    });

    it('keeps array order, because an array is ordered', () => {
        expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    });
});

describe('an artifact digest', () => {
    it('is the same for the same files in a different order', () => {
        const one = [file('a.js', 'sha256:1'), file('b.js', 'sha256:2')];
        const other = [file('b.js', 'sha256:2'), file('a.js', 'sha256:1')];

        expect(artifactDigest(one)).toBe(artifactDigest(other));
    });

    it('changes when a file changes', () => {
        expect(artifactDigest([file('a.js', 'sha256:1')]))
            .not.toBe(artifactDigest([file('a.js', 'sha256:2')]));
    });

    it('changes when a file is renamed, even with identical bytes', () => {
        // Otherwise moving a module would produce the same artifact under a name nothing served.
        expect(artifactDigest([file('a.js', 'sha256:1')]))
            .not.toBe(artifactDigest([file('b.js', 'sha256:1')]));
    });
});

describe('the input hash', () => {
    const inputs = { source: { kind: 'git', repository: 'r', ref: COMMIT } as const, entry: 'src/app.ts', builderVersion: '1' };

    it('is stable for the same inputs', () => {
        expect(inputHash(inputs)).toBe(inputHash({ ...inputs }));
    });

    it('changes when the entry changes', () => {
        expect(inputHash(inputs)).not.toBe(inputHash({ ...inputs, entry: 'src/other.ts' }));
    });

    it('changes when the builder changes, because the builder can change the output', () => {
        expect(inputHash(inputs)).not.toBe(inputHash({ ...inputs, builderVersion: '2' }));
    });

    it('refuses a branch', () => {
        // The failure this prevents is silent and late: a cache keyed on `main` answers the same
        // forever while the code moves, and shows up days later as "the deploy did nothing".
        expect(() => inputHash({ ...inputs, source: { kind: 'git', repository: 'r', ref: 'main' } }))
            .toThrow(/not a commit/);
    });

    it('refuses an archive with no digest', () => {
        expect(() => inputHash({ ...inputs, source: { kind: 'archive', url: 'u', digest: '  ' } }))
            .toThrow(/needs a digest/);
    });
});

describe('the URL slug', () => {
    it('drops the algorithm prefix', () => {
        expect(artifactSlug('sha256:abc123')).toBe('abc123');
    });

    it('leaves a bare hash alone', () => {
        expect(artifactSlug('abc123')).toBe('abc123');
    });
});

describe('content types', () => {
    it('serves JavaScript as JavaScript', () => {
        // A browser refuses a module served as text/plain, and the failure is invisible in a
        // network tab: the request is a 200.
        expect(contentTypeOf('app.js')).toBe('text/javascript; charset=utf-8');
        expect(contentTypeOf('app.mjs')).toBe('text/javascript; charset=utf-8');
    });

    it('falls back rather than guessing', () => {
        expect(contentTypeOf('LICENSE')).toBe('application/octet-stream');
        expect(contentTypeOf('data.unknownext')).toBe('application/octet-stream');
    });

    it('does not care how the extension was typed', () => {
        expect(contentTypeOf('INDEX.HTML')).toBe('text/html; charset=utf-8');
    });
});

describe('digests', () => {
    it('differ for different bytes and agree for the same', () => {
        expect(digestOf('a')).not.toBe(digestOf('b'));
        expect(digestOf('a')).toBe(digestOf(Buffer.from('a')));
    });
});
