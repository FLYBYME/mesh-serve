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

/**
 * **`node` and `seed` belong here, not in `package.json`.**
 *
 * They were npm scripts wrapping `bin/node.mjs` and `src/bring-up.ts`, which meant the two most
 * important commands on the platform were reachable only from a checkout of this repository — and
 * `publish` was a subcommand while `node` was not, with no principle behind the split.
 *
 * One binary has all of it. `npm run node` still works and is now an alias, which is the right
 * direction for that dependency: the script points at the CLI rather than the CLI existing beside
 * the scripts.
 */
if (command === 'node') {
    // Argv is rewritten because node.mjs reads `process.argv` directly, and it should keep doing so:
    // it is a program that happens to be reachable from here, not a function this file calls.
    process.argv = [process.argv[0], process.argv[1], ...rest];
    await import('./node.mjs');
    /**
     * No exit — the node runs until it is stopped, and **nothing after this may run**.
     *
     * This was three separate `if` statements, so a started node fell through to the last `else`,
     * the site client ran with no `--host`, printed "Which site?" and called `process.exit`. The
     * node had already announced itself, so the log said it was up and the process was gone: every
     * later command failed with `Tool "identity.register" not found`, which describes a mesh
     * discovery problem and not a dead process.
     *
     * One chain, so a branch that means *keep running* cannot be followed by one that means *exit*.
     */
} else if (command === 'seed') {
    process.argv = [process.argv[0], process.argv[1], ...rest];
    const { main } = await import('../dist/bring-up.js');
    try {
        await main();
        process.exit(0);
    } catch (error) {
        process.stderr.write(`Bring-up failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
} else if (command === 'client') {
    process.exit(await run(rest));
} else if (command === 'publish') {
    const { run_ } = await import('../dist/api/publish-cli.js');
    process.exit(await run_(rest));
} else if (command === 'dev') {
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
