/**
 * Copy a local `mesh-serve-live` into Atlas, so the fleet shares one database.
 *
 * **Copy, never move.** The source is left exactly as it was, so a failed or
 * half-finished run costs nothing and the old database stays a working fallback
 * until somebody deliberately deletes it.
 *
 * It is **idempotent by `_id`**: every document is upserted, so running it twice
 * converges rather than duplicating. That matters more than it sounds — a
 * migration you are afraid to re-run is one you cannot resume after a timeout,
 * and this one runs over a home connection.
 *
 * Usage:
 *   SOURCE_URI=mongodb://localhost:27017 \
 *   TARGET_URI='mongodb+srv://…' \
 *   node scripts/migrate-to-atlas.mjs [--commit]
 *
 * Without `--commit` it reports what it would copy and writes nothing.
 */

import { MongoClient } from 'mongodb';

const DB = process.env.DB_NAME ?? 'mesh-serve-live';
const commit = process.argv.includes('--commit');

const source = process.env.SOURCE_URI;
const target = process.env.TARGET_URI;

if (source === undefined || target === undefined) {
    process.stderr.write('SOURCE_URI and TARGET_URI are required.\n');
    process.exit(2);
}

const from = new MongoClient(source);
const to = new MongoClient(target);
await from.connect();
await to.connect();

const src = from.db(DB);
const dst = to.db(DB);

const names = (await src.listCollections().toArray()).map((c) => c.name).sort();
let totalRead = 0;
let totalWritten = 0;

for (const name of names) {
    const docs = await src.collection(name).find({}).toArray();
    totalRead += docs.length;

    const before = await dst.collection(name).countDocuments();

    if (docs.length > 0 && commit) {
        // Upsert by _id in one batch per collection. `replaceOne` rather than
        // `insertOne` is what makes a second run converge instead of failing on
        // every duplicate key.
        await dst.collection(name).bulkWrite(
            docs.map((doc) => ({
                replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
            })),
            { ordered: false },
        );
        totalWritten += docs.length;
    }

    const after = commit ? await dst.collection(name).countDocuments() : before;
    process.stdout.write(
        `${name.padEnd(16)} source=${String(docs.length).padStart(5)}  target ${String(before)} -> ${String(after)}\n`,
    );
}

process.stdout.write(
    `\n${commit ? 'copied' : 'would copy'} ${String(totalRead)} document(s) across `
    + `${String(names.length)} collection(s)${commit ? `, wrote ${String(totalWritten)}` : ' — dry run, nothing written'}\n`,
);

await from.close();
await to.close();
process.exit(0);
