import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { GridFSBucket, type Db } from 'mongodb';
import type { Database, IServiceBroker } from '@flybyme/mesh';

import { artifactFolder } from './artifacts.js';

/**
 * Every build's files, kept in the database as well as on the disks that have them (GridFS,
 * bucket `artifactFiles`, one file per asset named `<hash>/<path>`). A build used to live only on
 * the node that made it and on nodes that had copied it: lose that disk and every build nobody had
 * copied was gone while its record said it existed. The database is the one store every node
 * reaches, and Atlas backs it up. Builds are small (a few MB).
 */
const BUCKET = 'artifactFiles';

function bucketOf(broker: IServiceBroker): GridFSBucket | undefined {
    // getProvider returns undefined for a provider this node never registered.
    const db: Db | null | undefined = broker.getProvider<Database | undefined>('database')?.getDb();
    return db ? new GridFSBucket(db, { bucketName: BUCKET }) : undefined;
}

const fileName = (hash: string, assetPath: string): string => `${hash}/${assetPath}`;

/**
 * Keeps a build's files in the database. Idempotent and resumable: a file already stored is left
 * alone, so an interrupted store is completed by the next one. Returns how many files it wrote.
 */
export async function storeArtifact(broker: IServiceBroker, hash: string, assetPaths: readonly string[], nodeID?: string): Promise<number> {
    const bucket = bucketOf(broker);
    if (!bucket) throw new Error('no database on this node to keep the build in');
    const stored = new Set((await bucket.find({ 'metadata.hash': hash }).toArray()).map((f) => f.filename));
    let written = 0;
    for (const assetPath of assetPaths) {
        const name = fileName(hash, assetPath);
        if (stored.has(name)) continue;
        const content = await fs.readFile(path.join(artifactFolder(hash, nodeID), ...assetPath.split('/')));
        await new Promise<void>((resolve, reject) => {
            const upload = bucket.openUploadStream(name, { metadata: { hash, path: assetPath } });
            upload.once('finish', () => resolve());
            upload.once('error', reject);
            upload.end(content);
        });
        written++;
    }
    return written;
}

/** Every stored build's hash, with how many files and bytes it holds in the database. */
export async function storedBuilds(broker: IServiceBroker): Promise<Map<string, { files: number; bytes: number }>> {
    const bucket = bucketOf(broker);
    if (!bucket) throw new Error('no database on this node to read stored builds from');
    const out = new Map<string, { files: number; bytes: number }>();
    for (const f of await bucket.find({}, { projection: { length: 1, 'metadata.hash': 1 } }).toArray()) {
        const hash: unknown = f.metadata?.hash;
        if (typeof hash !== 'string') continue;
        const cur = out.get(hash) ?? { files: 0, bytes: 0 };
        out.set(hash, { files: cur.files + 1, bytes: cur.bytes + f.length });
    }
    return out;
}

/** Deletes one build's files from the database (its record is the caller's). Returns how many. */
export async function dropStoredBuild(broker: IServiceBroker, hash: string): Promise<number> {
    const bucket = bucketOf(broker);
    if (!bucket) throw new Error('no database on this node to drop a build from');
    const files = await bucket.find({ 'metadata.hash': hash }, { projection: { _id: 1 } }).toArray();
    for (const f of files) await bucket.delete(f._id);
    return files.length;
}

/**
 * Writes a build's files from the database onto this node's disk -- checked, file by file, against
 * the sha384 integrity its record carries, so what comes back is exactly what was built. Written
 * to a temporary folder and renamed in. Throws if any file is missing or does not match.
 */
export async function restoreArtifact(
    broker: IServiceBroker,
    hash: string,
    assets: ReadonlyArray<{ readonly url: string; readonly integrity?: string | undefined }>,
    nodeID?: string,
): Promise<void> {
    const bucket = bucketOf(broker);
    if (!bucket) throw new Error('no database on this node to restore the build from');
    const finalDir = artifactFolder(hash, nodeID);
    const staging = `${finalDir}.restoring-${crypto.randomUUID()}`;
    try {
        for (const asset of assets) {
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                bucket.openDownloadStreamByName(fileName(hash, asset.url))
                    .on('data', (c: Buffer) => chunks.push(c))
                    .once('end', () => resolve())
                    .once('error', reject);
            });
            const content = Buffer.concat(chunks);
            const integrity = `sha384-${crypto.createHash('sha384').update(content).digest('base64')}`;
            if (asset.integrity !== undefined && asset.integrity !== integrity) {
                throw new Error(`"${asset.url}" in the database does not match the build's record`);
            }
            const destination = path.join(staging, ...asset.url.split('/'));
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, content);
        }
        await fs.rename(staging, finalDir).catch(async (err: unknown) => {
            // Another copy arrived first: identical content, keep it.
            if (!(await fs.access(finalDir).then(() => true, () => false))) throw err;
        });
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}
