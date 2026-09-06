/**
 * Where artifact bytes live: **on the node's disk, never in the database.**
 *
 * An artifact *record* is a row, and `artifactCrud` plus mesh's `DatabaseModule` already persist it —
 * the database middleware intercepts every CRUD call and does the mongo work, so a store for those
 * records would be code doing nothing the framework is not doing.
 *
 * **Bytes are not rows.** They went to GridFS first, which was wrong for a reason that only became
 * clear once the edge model did: an edge's disk is a **cache**, not durable storage. A pod's volume
 * is deleted on restart. So there is no point paying for durable storage that nothing relies on
 * being durable — what makes an artifact recoverable is the catalog's commit and a deterministic
 * build, not a replica set.
 *
 * That reframes this file. It is not a store; it is a cache with a content-addressed key, and every
 * property it has follows from the key being the hash:
 *
 * - **immutable** — a second write under one key is either identical bytes or a hash collision
 * - **shared** — two artifacts containing the same chunk hold it once
 * - **verifiable** — a corrupt or truncated file is detectable, because the name is what the
 *   contents should hash to
 * - **safe to evict** — anything lost can be fetched from a peer or rebuilt
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BlobStore {
    has(digest: string): Promise<boolean>;
    /**
     * How big it is, without reading it.
     *
     * The question a caller asking *where do I download this* actually needs answered. Separate from
     * `get` because answering it must not pull megabytes through a process that is only going to
     * hand back a URL.
     */
    stat(digest: string): Promise<{ readonly size: number } | undefined>;
    get(digest: string): Promise<Buffer | undefined>;
    put(digest: string, content: Buffer): Promise<void>;
    /** Remove one. Safe by construction: anything here can be refetched or rebuilt. */
    delete(digest: string): Promise<void>;
}

/**
 * Where a digest lives under the root.
 *
 * Split two characters deep — `sha256:ab12cd…` → `<root>/ab/12cd…`. Not cosmetic: a directory with a
 * hundred thousand entries is slow to enumerate on most filesystems and unpleasant to look at on all
 * of them. Two characters gives 256 buckets, which is enough at this scale and trivially extended.
 *
 * The algorithm prefix is dropped from the path and kept in the record, where something could one
 * day migrate it. A colon in a filename is legal and awkward on enough systems to be worth avoiding.
 */
export function pathFor(root: string, digest: string): string {
    const hex = digest.slice(digest.indexOf(':') + 1);
    return join(root, hex.slice(0, 2), hex.slice(2));
}

/** A digest that would escape the root, or name nothing. Refused rather than sanitised. */
function assertDigest(digest: string): void {
    const hex = digest.slice(digest.indexOf(':') + 1);
    if (!/^[0-9a-f]{8,}$/.test(hex)) {
        throw new Error(
            `"${digest}" is not a content digest. A path is built from it, so it is checked rather ` +
            `than cleaned: a value that needed cleaning was a value from somewhere it should not be.`,
        );
    }
}

export interface FileBlobStoreOptions {
    readonly root: string;
    /**
     * Check that bytes read back hash to the name they are under.
     *
     * Off by default: it costs a hash over every read on the serving path, and the failure it
     * catches — a truncated or corrupted cache file — is rare. Worth turning on for a node that has
     * been misbehaving, which is exactly when *is my cache lying to me* is the question.
     */
    readonly verify?: boolean;
}

export function fileBlobStore(options: FileBlobStoreOptions): BlobStore {
    const { root } = options;
    const verify = options.verify ?? false;

    return {
        async has(digest) {
            return await this.stat(digest) !== undefined;
        },

        async stat(digest) {
            assertDigest(digest);
            try {
                const found = await stat(pathFor(root, digest));
                return found.isFile() ? { size: found.size } : undefined;
            } catch {
                return undefined;
            }
        },

        async get(digest) {
            assertDigest(digest);
            let content: Buffer;
            try {
                content = await readFile(pathFor(root, digest));
            } catch {
                return undefined;
            }

            if (verify) {
                const actual = `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
                if (actual !== digest) {
                    // Treated as absent rather than thrown: the caller's next move — fetch it from a
                    // peer, or rebuild — is the same as for a file that was never here, and a cache
                    // that lies should look empty rather than break the request.
                    await this.delete(digest);
                    return undefined;
                }
            }

            return content;
        },

        async put(digest, content) {
            assertDigest(digest);
            const path = pathFor(root, digest);

            // Immutable by construction, so a re-put is a no-op rather than a rewrite. Also the
            // cheap half of concurrency: two builds producing identical bytes race to write the same
            // file and the second does nothing.
            if (await this.has(digest)) return;

            await mkdir(dirname(path), { recursive: true });

            // Written aside and renamed, because **rename is atomic and a write is not.** A crash
            // halfway through a direct write leaves a short file under a name that says what it
            // should hash to, and every later reader trusts the name. The temp name carries the pid
            // and a random token so concurrent writes to the same digest do not truncate each other.
            const staging = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2)}.tmp`;
            try {
                await writeFile(staging, content);
                await rename(staging, path);
            } catch (error) {
                await rm(staging, { force: true });
                throw error;
            }
        },

        async delete(digest) {
            assertDigest(digest);
            await rm(pathFor(root, digest), { force: true });
        },
    };
}

/**
 * Everything in memory.
 *
 * A real single-node deployment for a test, and nothing else — an edge that restarts loses its
 * cache either way, so this differs from the file store in speed rather than in kind.
 */
export function memoryBlobStore(): BlobStore {
    const blobs = new Map<string, Buffer>();

    return {
        async has(digest) { return blobs.has(digest); },
        async stat(digest) {
            const held = blobs.get(digest);
            return held === undefined ? undefined : { size: held.length };
        },
        async get(digest) { return blobs.get(digest); },
        async put(digest, content) { if (!blobs.has(digest)) blobs.set(digest, content); },
        async delete(digest) { blobs.delete(digest); },
    };
}
