/**
 * Content addressing, descriptors, and blob storage.
 *
 * The parts of building that decide whether two builds are the same build. All pure or on a
 * temporary directory, so none of it needs a git remote or a bundler.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { artifactDigest, artifactSlug, canonical, contentTypeOf, digestOf, inputHash } from '../src/build/methods/content.js';
import { fileBlobStore } from '../src/build/methods/blobs.js';
import { parseDescriptor } from '../src/build/schema/descriptor.js';

const file = (path: string, digest: string) => ({ path, digest, size: 1, contentType: 'text/plain' });

describe('content addressing', () => {
    it('hashes the same content to the same digest', () => {
        expect(digestOf('hello')).toBe(digestOf('hello'));
        expect(digestOf('hello')).not.toBe(digestOf('hellp'));
    });

    /**
     * `JSON.stringify` orders keys by insertion, so two inputs meaning the same thing would hash
     * differently depending on how they were built — and a cache missing on that looks like a
     * builder that never caches.
     */
    it('canonicalises key order, so equal values serialise equally', () => {
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(canonical({ a: { d: 1, c: 2 } })).toBe(canonical({ a: { c: 2, d: 1 } }));
    });

    /**
     * Over the names and digests, sorted — not the concatenated bytes. Two artifacts with the same
     * files in a different order are the same artifact, and hashing bytes in directory order would
     * make identity depend on a filesystem.
     */
    it('gives one digest to a file set whatever order it arrives in', () => {
        const one = artifactDigest([file('a.js', 'sha256:aa'), file('b.js', 'sha256:bb')]);
        const other = artifactDigest([file('b.js', 'sha256:bb'), file('a.js', 'sha256:aa')]);
        expect(one).toBe(other);
    });

    it('changes the digest when a file changes', () => {
        const before = artifactDigest([file('a.js', 'sha256:aa')]);
        const after = artifactDigest([file('a.js', 'sha256:cc')]);
        expect(before).not.toBe(after);
    });

    const inputs = {
        source: { kind: 'git' as const, repository: 'r', ref: 'a'.repeat(40) },
        partId: 'ui',
        entry: 'src/index.ts',
        kind: 'extension' as const,
        external: ['@flybyme/mesh-web'],
        builder: 'mesh-serve/1',
    };

    /**
     * **A branch is refused rather than warned about.** A cache key computed from a branch name is a
     * bug that surfaces as *"the deploy did nothing"*, days later, with nothing in any log.
     */
    it('refuses a source that is not resolved to a commit', () => {
        expect(() => inputHash({ ...inputs, source: { ...inputs.source, ref: 'main' } }))
            .toThrow(/not a commit/);
    });

    it('is stable for the same inputs and changes for a different builder', () => {
        expect(inputHash(inputs)).toBe(inputHash(inputs));
        expect(inputHash(inputs)).not.toBe(inputHash({ ...inputs, builder: 'mesh-serve/2' }));
    });

    /** A different external set is a different bundle, so it has to reach the hash. */
    it('changes when the external set changes', () => {
        expect(inputHash(inputs)).not.toBe(inputHash({ ...inputs, external: [] }));
    });

    it('drops the algorithm prefix for a URL, and keeps the identity', () => {
        expect(artifactSlug('sha256:abcdef')).toBe('abcdef');
        expect(artifactSlug('abcdef')).toBe('abcdef');
    });

    /** A browser refuses a module served as `text/plain`, and that failure is invisible. */
    it('names javascript as javascript', () => {
        expect(contentTypeOf('index.js')).toMatch(/javascript/);
        expect(contentTypeOf('a/b.css')).toMatch(/text\/css/);
        expect(contentTypeOf('what')).toBe('application/octet-stream');
    });
});

describe('descriptors', () => {
    it('reads the parts a repository declares', () => {
        const descriptor = parseDescriptor(JSON.stringify({
            parts: [{ kind: 'extension', id: 'ui', entry: 'src/index.ts' }],
        }), 'demo');

        expect(descriptor.parts[0]).toMatchObject({ id: 'ui', kind: 'extension' });
    });

    /** `//`-prefixed keys are how this repository's own descriptors carry their reasoning. */
    it('ignores comment keys', () => {
        const descriptor = parseDescriptor(JSON.stringify({
            '//why': 'a note',
            parts: [{ '//x': 'note', kind: 'kernel', id: 'k', entry: 'a.ts' }],
        }), 'demo');

        expect(descriptor.parts).toHaveLength(1);
    });

    /**
     * Both forms, because the real descriptors in this fleet write the object and a repository with
     * one dependency and no opinion about versions wants to write the string.
     */
    it('accepts requiredParts as objects or as bare strings', () => {
        const descriptor = parseDescriptor(JSON.stringify({
            parts: [
                { kind: 'application', id: 'a', entry: 'a.ts', requiredParts: [{ id: 'ui', version: '^0.1' }] },
                { kind: 'application', id: 'b', entry: 'b.ts', requiredParts: ['ui'] },
            ],
        }), 'demo');

        expect(descriptor.parts[0]?.requiredParts[0]).toEqual({ id: 'ui', version: '^0.1' });
        expect(descriptor.parts[1]?.requiredParts[0]).toEqual({ id: 'ui', version: '*' });
    });

    /** The person reading this is looking at their own repository, so the message names the file. */
    it('names the repository, the path and the problem', () => {
        expect(() => parseDescriptor('{"parts":[{"kind":"nope","id":"x","entry":"a.ts"}]}', 'mesh-core'))
            .toThrow(/mesh-core\/mesh\.json/);
        expect(() => parseDescriptor('not json', 'mesh-core')).toThrow(/not valid JSON/);
    });

    /** A path that leaves the repository is a build reading something the author did not publish. */
    it('refuses a path that escapes the repository', () => {
        expect(() => parseDescriptor('{"parts":[{"kind":"kernel","id":"k","entry":"../secrets"}]}', 'x'))
            .toThrow(/may not leave it/);
    });
});

describe('blob storage', () => {
    let root: string;

    beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'mesh-blob-test-')); });
    afterAll(async () => { await rm(root, { recursive: true, force: true }); });

    it('writes once and reports the second write as a no-op', async () => {
        const store = fileBlobStore(root);
        const content = Buffer.from('hello');
        const digest = digestOf(content);

        expect(await store.put(digest, content)).toBe(true);
        expect(await store.put(digest, content)).toBe(false);
        expect(await store.get(digest)).toEqual(content);
        expect(await store.has(digest)).toBe(true);
    });

    /** Missing bytes are ordinary: an edge's disk is a cache. The caller decides what that means. */
    it('answers undefined for bytes it does not hold', async () => {
        expect(await fileBlobStore(root).get(digestOf('absent'))).toBeUndefined();
    });

    /**
     * A digest arrives from a database row, and a row is data somebody else may have written. One
     * containing a slash or `..` would be a path traversal into whatever this process can write.
     */
    it('refuses a digest that is not a digest', async () => {
        const store = fileBlobStore(root);
        await expect(store.get('../../etc/passwd')).rejects.toThrow(/is not a digest/);
        await expect(store.put('a/b', Buffer.from('x'))).rejects.toThrow(/is not a digest/);
    });
});
