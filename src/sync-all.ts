/**
 * Discovers every site spec (`*.site.yaml`, `*.site.json`) under a known set of directories and
 * syncs each one in turn (`syncSpec`, sync.ts) -- lists what it found before touching anything, so
 * a missing site is obvious up front rather than a silent gap.
 *
 * Not a hardcoded {site path -> out path} registry, deliberately: that's the same shape of bug this
 * session already found once (console.site.json's `exposed` list silently missing
 * identity.ticket.signOut, hand-maintained and drifted). This never asks for a client at all --
 * `outPath` is always `undefined` below -- so discovering *files* is sufficient, with no second list
 * of paths to keep in sync with the first. A generated client is `generate`'s job (or `sync --out`
 * for one site at a time), not this one's.
 *
 * Usage: npx tsx src/sync-all.ts [--force]
 * `--force` is passed through to every site's own syncArtifacts (rebuilds even a cached artifact).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncSpec } from './sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where a site spec is allowed to live. Both are real today: console.site.yaml ships inside this
 *  package, a company site (git.site.yaml, say) lives alongside the company repos it composes,
 *  outside this repo entirely. */
const SEARCH_DIRS = [
    here,
    '/home/ubuntu/code/company/sites',
];

async function findSiteFiles(): Promise<readonly string[]> {
    const found: string[] = [];
    for (const dir of SEARCH_DIRS) {
        let entries: readonly string[];
        try {
            entries = await fs.readdir(dir);
        } catch {
            continue; // A search directory that doesn't exist (yet) contributes no sites, not an error.
        }
        for (const entry of entries) {
            if (entry.endsWith('.site.yaml') || entry.endsWith('.site.yml') || entry.endsWith('.site.json')) {
                found.push(path.join(dir, entry));
            }
        }
    }
    return found;
}

function parseArgs(argv: readonly string[]): { force: boolean } {
    return { force: argv.includes('--force') };
}

async function main(): Promise<void> {
    const { force } = parseArgs(process.argv.slice(2));
    const files = await findSiteFiles();

    if (files.length === 0) {
        console.log('No *.site.yaml/*.site.json found under', SEARCH_DIRS.join(', '));
        return;
    }

    console.log(`Found ${String(files.length)} site(s):`);
    for (const file of files) console.log(' -', file);

    const failures: { file: string; message: string }[] = [];

    for (const file of files) {
        console.log(`\n=== ${file} ===`);
        try {
            await syncSpec(file, undefined, force);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Failed: ${message}`);
            failures.push({ file, message });
        }
    }

    console.log(`\n${String(files.length - failures.length)}/${String(files.length)} site(s) synced.`);
    if (failures.length > 0) {
        console.log('Failed:');
        for (const { file, message } of failures) console.log(` - ${file}: ${message}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
