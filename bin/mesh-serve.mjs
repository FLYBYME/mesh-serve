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
    /**
     * **Everything else is the site's, not this file's.**
     *
     * The three above are build-time tools — they work on a checkout and never call a cluster. The
     * rest of the CLI is a *projection of a site's exposure*, so there is no list of commands here
     * and there must not be one: a command a site exposes exists because it exposes it, and a second
     * place to add it is the place that gets forgotten.
     *
     * See `spec/cli.md`.
     */
    const { run: runCli } = await import('../dist/cli/run.js');
    const { createInterface } = await import('node:readline/promises');

    process.exit(await runCli(process.argv.slice(2), {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        prompt: async (question, hidden) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
            try {
                if (!hidden) return (await rl.question(question)).trim();

                /**
                 * A password is never echoed, and never read from argv.
                 *
                 * A value typed as `--password …` is visible in `ps` to every user on the machine and
                 * lands in a shell history file. `publish-cli` was fixed for the same reason (F6).
                 */
                const wasRaw = process.stdin.isRaw ?? false;
                process.stdout.write(question);
                rl.output.write = () => true;
                const answer = await rl.question('');
                process.stdout.write('\n');
                if (process.stdin.isTTY === true && !wasRaw) process.stdin.setRawMode(false);
                return answer.trim();
            } finally {
                rl.close();
            }
        },
    }));
}
