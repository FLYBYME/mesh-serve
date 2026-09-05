/**
 * Where artifact bytes live.
 *
 * An artifact *record* is a row, and `artifactCrud` plus mesh's `DatabaseModule` already persist it
 * — the database middleware intercepts every CRUD call and does the mongo work, so a store
 * interface for those records would be code doing nothing the framework is not doing.
 *
 * **Bytes are not rows.** A mongo document caps at 16 MB and a bundle can exceed it, so blobs go to
 * GridFS, which is chunked storage in the same database, reached through the `database` provider the
 * framework already registers on the broker.
 *
 * Keyed by content digest, which makes two properties fall out rather than needing to be built:
 * **a blob is immutable** (a second write under one key is either identical bytes or a hash
 * collision), and **blobs are shared** (two parts that emit an identical chunk store it once, and a
 * rebuild that changed one part re-stores nothing for the other).
 */

import { GridFSBucket, type Db } from 'mongodb';

/** What this needs from mesh's `Database`, and no more. */
interface DatabaseProvider {
    getDb(): Db | null;
}

export interface BlobStore {
    has(digest: string): Promise<boolean>;
    /**
     * How big it is, without reading it.
     *
     * The question a caller asking *where do I download this* actually needs answered, and the one
     * `has` cannot answer. Separate from `get` because answering it must not pull megabytes through
     * a process that is only going to hand back a URL.
     */
    stat(digest: string): Promise<{ readonly size: number } | undefined>;
    get(digest: string): Promise<Buffer | undefined>;
    put(digest: string, content: Buffer): Promise<void>;
}

export const BLOB_BUCKET = 'artifacts';

/**
 * GridFS, over the database the framework connected.
 *
 * The digest is the filename, so `has` is an index lookup rather than a read. That is the question
 * asked most often — a serving node checking whether it needs to fetch — and answering it without
 * pulling bytes is what makes a cold cache slower rather than wrong.
 */
export function gridfsBlobStore(database: DatabaseProvider): BlobStore {
    const bucketOf = (): GridFSBucket => {
        const db = database.getDb();
        if (db === null) {
            throw new Error('The database is not connected, so artifact bytes cannot be stored.');
        }
        return new GridFSBucket(db, { bucketName: BLOB_BUCKET });
    };

    return {
        async has(digest) {
            return await this.stat(digest) !== undefined;
        },

        async stat(digest) {
            // GridFS keeps a `files` document per blob carrying its length, so size is an index
            // lookup rather than a read. That is what lets `artifact_blob` answer *how big is it*
            // without pulling megabytes through a process that is only going to return a URL.
            const [found] = await bucketOf().find({ filename: digest }, { limit: 1 }).toArray();
            return found === undefined ? undefined : { size: found.length };
        },

        async get(digest) {
            if (!await this.has(digest)) return undefined;

            const chunks: Buffer[] = [];
            for await (const chunk of bucketOf().openDownloadStreamByName(digest)) {
                chunks.push(Buffer.from(chunk as Uint8Array));
            }
            return Buffer.concat(chunks);
        },

        async put(digest, content) {
            // Immutable by construction, so a re-put is a no-op rather than a second copy. Checked
            // rather than upserted because GridFS has no upsert: writing again would leave two
            // revisions under one name and `openDownloadStreamByName` would quietly serve the newer.
            if (await this.has(digest)) return;

            await new Promise<void>((resolve, reject) => {
                const upload = bucketOf().openUploadStream(digest);
                upload.once('error', reject);
                upload.once('finish', () => { resolve(); });
                upload.end(content);
            });
        },
    };
}
