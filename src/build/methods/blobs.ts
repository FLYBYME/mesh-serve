/**
 * Where the bytes go.
 *
 * **An artifact's record lives in the database and its bytes live here**, because a document store
 * is the wrong place for a megabyte of JavaScript and because the two have different lifetimes: the
 * record is the truth, the bytes are a cache that may be `gone` and rebuilt.
 *
 * Content-addressed on disk, so writing the same content twice is a no-op and two builds that
 * produced the same bytes share one file.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { artifactSlug } from './content.js';

export interface BlobStore {
    /** Write one blob. Returns false when it was already there, which is the ordinary case. */
    put(digest: string, content: Buffer): Promise<boolean>;
    get(digest: string): Promise<Buffer | undefined>;
    has(digest: string): Promise<boolean>;
}

/**
 * Blobs under a directory, two levels deep.
 *
 * `ab/cdef…` rather than one flat directory: a few thousand artifacts in a single directory is slow
 * to list on every filesystem and unusable on some, and the fan-out costs nothing.
 */
export function fileBlobStore(root: string): BlobStore {
    const pathFor = (digest: string): string => {
        const slug = artifactSlug(digest);

        /**
         * **The digest is checked before it becomes a path.**
         *
         * It arrives from a database row, and a row is data somebody else may have written. A digest
         * that could contain a slash or `..` is a path traversal into whatever this process can
         * write, so the shape is asserted rather than trusted — even though every digest this
         * package mints is hex by construction.
         */
        if (!/^[0-9a-f]{8,128}$/.test(slug)) {
            throw new Error(`"${digest}" is not a digest, so it cannot name a file.`);
        }

        return join(resolve(root), slug.slice(0, 2), slug.slice(2));
    };

    return {
        async put(digest, content) {
            const path = pathFor(digest);
            if (await exists(path)) return false;

            /**
             * **Written to a temporary name and renamed**, because a reader must never see a partial
             * file under a name that promises complete content. A crash mid-write otherwise leaves a
             * blob whose digest is a lie, and content addressing stops meaning anything.
             */
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${createHash('sha256').update(digest).digest('hex').slice(0, 8)}.partial`;
            await writeFile(temporary, content);
            await rename(temporary, path);

            return true;
        },

        async get(digest) {
            /**
             * **The guard runs outside the catch, and putting it inside hid it.**
             *
             * `pathFor` refuses a digest that is not a digest, which is the check that stops a
             * database row naming a path. Inside the `try` that refusal was swallowed by the same
             * `catch` that handles missing bytes, so `get('../../etc/passwd')` answered *no bytes* —
             * the guard passing for the wrong reason, which is the failure mode a guard is least
             * likely to be noticed in.
             */
            const path = pathFor(digest);

            try {
                return await readFile(path);
            } catch {
                // Missing bytes are ordinary: an edge's disk is a cache. The caller decides whether
                // that means "rebuild" or "this node cannot serve it".
                return undefined;
            }
        },

        async has(digest) {
            return exists(pathFor(digest));
        },
    };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
