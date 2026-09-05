#!/usr/bin/env node
/**
 * The mesh-serve CLI.
 *
 * One subcommand so far — `client`, which turns a part repository's `mesh.json` into the typed API
 * code that repository would otherwise hand-write.
 */

import { readFileSync } from 'node:fs';

import { run } from '../dist/api/client-cli.js';
import { serveDev, writeDevPage } from '../dist/api/dev-page.js';
import { parseDescriptor } from '../dist/builder/schema/descriptor.js';

const [command, ...rest] = process.argv.slice(2);

const value = (flag, fallback) => {
    const at = rest.indexOf(flag);
    return at === -1 ? fallback : rest[at + 1];
};

if (command === 'client') {
    process.exit(await run(rest));
}

if (command === 'publish') {
    const { run_ } = await import('../dist/api/publish-cli.js');
    process.exit(await run_(rest));
}

if (command === 'dev') {
    const root = process.cwd();
    const descriptor = parseDescriptor(readFileSync(value('--descriptor', 'mesh.json'), 'utf8'));

    const { dir, files, warnings } = await writeDevPage(root, descriptor);
    for (const warning of warnings) process.stderr.write(`note: ${warning}\n`);
    process.stdout.write(`${String(files.length)} file(s) in ${dir}\n`);

    if (!rest.includes('--no-serve')) {
        const url = await serveDev(dir, Number(value('--port', '8080')));
        process.stdout.write(`\n  ${url}\n\nCtrl-C to stop.\n`);
    } else {
        process.exit(0);
    }
} else {
    process.stderr.write(
        'usage: mesh-serve client  [--descriptor mesh.json] [--out src/generated/api.ts]\n' +
        '                          [--descriptor-out descriptor.json] [--check]\n' +
        '       mesh-serve dev     [--descriptor mesh.json] [--port 8080] [--no-serve]\n' +
        '       mesh-serve publish --publisher <org> [--repository <url>] [--dry-run]\n',
    );
    process.exit(command === undefined ? 1 : 2);
}
