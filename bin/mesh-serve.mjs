#!/usr/bin/env node
/**
 * The mesh-serve CLI.
 *
 * One subcommand so far — `client`, which turns a part repository's `mesh.json` into the typed API
 * code that repository would otherwise hand-write.
 */

import { run } from '../dist/api/client-cli.js';

const [command, ...rest] = process.argv.slice(2);

if (command !== 'client') {
    process.stderr.write(
        'usage: mesh-serve client [--descriptor mesh.json] [--out src/generated/api.ts]\n' +
        '                         [--descriptor-out descriptor.json] [--check]\n',
    );
    process.exit(command === undefined ? 1 : 2);
}

process.exit(await run(rest));
