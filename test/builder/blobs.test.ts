/**
 * The blob store.
 *
 * A cache with a content-addressed key, not durable storage — an edge's disk is deleted when its pod
 * restarts, and what makes an artifact recoverable is the catalog's commit plus a deterministic
 * build. Every property tested here follows from the key being the hash.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileBlobStore, memoryBlobStore, pathFor, type BlobStore } from '../../src/builder/blobs.js';
import { digestOf } from '../../src/builder/methods/content.js';

let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mesh-blobs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const content = Buffer.from('console.log("hello")');
const digest = digestOf(content);

describe('paths', () => {
    it('splits two characters deep, so no directory holds a hundred thousand files', () => {
        expect(pathFor('/r', 'sha256:ab12cd34')).toBe('/r/ab/12cd34');
    });

    it('drops the algorithm prefix, which is awkward in a filename and kept in the record', () => {
        expect(pathFor('/r', 'sha256:ab12cd34')).not.toContain(':');
    });

    it('refuses anything that could escape the root', () => {
        // Checked rather than sanitised: a value that needed cleaning came from somewhere it should
        // not have.
        const store = fileBlobStore({ root: '/r' });
        for (const bad of ['sha256:../../etc/passwd', '../x', 'sha256:', 'sha256:NOTHEX']) {
            expect(store.stat(bad)).rejects.toThrow(/not a content digest/);
        }
    });
});

const behavesLikeABlobStore = (make: () => BlobStore): void => {
    it('round-trips', async () => {
        const store = make();
        await store.put(digest, content);

        expect(await store.get(digest)).toEqual(content);
        expect(await store.has(digest)).toBe(true);
    });

    it('answers size without reading the bytes', async () => {
        // What a caller asking "where do I download this" needs. Answering it must not pull
        // megabytes through a process that is only going to return a URL.
        const store = make();
        await store.put(digest, content);

        expect(await store.stat(digest)).toEqual({ size: content.length });
    });

    it('has nothing for a digest it never held', async () => {
        const store = make();
        expect(await store.get(digest)).toBeUndefined();
        expect(await store.stat(digest)).toBeUndefined();
        expect(await store.has(digest)).toBe(false);
    });

    it('is immutable: a second put does not rewrite', async () => {
        // A second write under one key is either identical bytes or a hash collision, and
        // overwriting would be wrong either way.
        const store = make();
        await store.put(digest, content);
        await store.put(digest, Buffer.from('something else entirely'));

        expect(await store.get(digest)).toEqual(content);
    });

    it('deletes, because everything here can be refetched or rebuilt', async () => {
        const store = make();
        await store.put(digest, content);
        await store.delete(digest);

        expect(await store.has(digest)).toBe(false);
    });

    it('deleting something absent is not an error', async () => {
        // Eviction races a fetch that already evicted it, and neither caller did anything wrong.
        await expect(make().delete(digest)).resolves.toBeUndefined();
    });
};

describe('the file store', () => {
    behavesLikeABlobStore(() => fileBlobStore({ root }));

    it('leaves no temporary file behind', async () => {
        // Written aside and renamed, because rename is atomic and a write is not: a crash halfway
        // through a direct write leaves a short file under a name that says what it should hash to,
        // and every later reader trusts the name.
        const store = fileBlobStore({ root });
        await store.put(digest, content);

        const { readdir } = await import('node:fs/promises');
        const bucket = await readdir(join(root, digest.slice(digest.indexOf(':') + 1, digest.indexOf(':') + 3)));

        expect(bucket.some((name) => name.endsWith('.tmp'))).toBe(false);
        expect(bucket).toHaveLength(1);
    });

    it('shares a blob between artifacts, because the key is the content', async () => {
        const store = fileBlobStore({ root });
        await store.put(digest, content);
        await store.put(digest, content);

        expect(await readFile(pathFor(root, digest))).toEqual(content);
    });

    describe('verification', () => {
        it('is off by default, because it costs a hash on every read', async () => {
            const store = fileBlobStore({ root });
            await store.put(digest, content);
            await writeFile(pathFor(root, digest), 'truncated');

            expect(await store.get(digest)).toEqual(Buffer.from('truncated'));
        });

        it('treats a corrupt file as absent, and drops it', async () => {
            // Absent rather than an error: the caller's next move — fetch from a peer, or rebuild —
            // is the same as for a file that was never here, and a cache that lies should look
            // empty rather than break the request.
            const store = fileBlobStore({ root, verify: true });
            await store.put(digest, content);
            await writeFile(pathFor(root, digest), 'truncated');

            expect(await store.get(digest)).toBeUndefined();
            expect(await store.has(digest)).toBe(false);
        });

        it('returns good bytes unchanged', async () => {
            const store = fileBlobStore({ root, verify: true });
            await store.put(digest, content);

            expect(await store.get(digest)).toEqual(content);
        });
    });
});

describe('the memory store', () => {
    behavesLikeABlobStore(() => memoryBlobStore());
});
