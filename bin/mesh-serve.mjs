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
import { Command } from 'commander';
const fixedCommands = ['node', 'seed', 'client', 'publish', 'dev'];

if (fixedCommands.includes(command)) {
    const program = new Command(`mesh-serve ${command}`);
    program.showHelpAfterError();

    if (command === 'node') {
        program.description('run a node: all services, one process')
            .option('--env <path>', 'path to .env file')
            .option('--ws <port>', 'websocket port', '4001')
            .option('--ws-host <host>', 'websocket host', '127.0.0.1')
            .option('--cdn <port>', 'cdn port', '8080')
            .option('--cdn-url <url>', 'cdn url')
            .option('--api <port>', 'api port', '5005')
            .option('--mongo <uri>', 'mongodb uri')
            .option('--db <name>', 'database name', 'mesh-serve')
            .option('--artifacts <path>', 'artifacts blob root')
            .option('--bootstrap <nodes>', 'comma-separated bootstrap nodes')
            .option('--id <id>', 'node ID')
            .option('--mcp <port>', 'mcp port')
            .option('--service <path>', 'load a module this node did not ship with', (v, p) => p.concat([v]), [])
            .allowUnknownOption(false)
            .action(async () => {
                process.argv = [process.argv[0], process.argv[1], ...rest];
                await import('./node.mjs');
            });
    } else if (command === 'seed') {
        program.description('bring an empty cluster up to a hostname that answers')
            .option('--email <email>', 'account email')
            .option('--password <password>', 'account password')
            .option('--set-password <password>', 'set a new password and claim a provisional account')
            .option('--control <url>', 'the node you sign in to')
            .option('--host <hostname>', 'the site hostname to seed')
            .option('--repo <url>', 'git repository url or path', (v, p) => p.concat([v]), [])
            .option('--parts <parts>', 'comma-separated list of parts')
            .option('--org-slug <slug>', 'organization slug')
            .option('--org-name <name>', 'organization name')
            .option('--application <app>', 'application name')
            .option('--title <title>', 'site title')
            .option('--api <url>', 'the URL the served page will call')
            .option('--policy <json>', 'site policy as JSON object')
            .option('--ref <ref>', 'git ref to clone')
            .option('--import-only', 'import repositories but do not compose')
            .allowUnknownOption(false)
            .action(async () => {
                process.argv = [process.argv[0], process.argv[1], ...rest];
                const { main } = await import('../dist/bring-up.js');
                try {
                    await main();
                    process.exit(0);
                } catch (error) {
                    process.stderr.write(`Bring-up failed: ${error instanceof Error ? error.message : String(error)}\n`);
                    process.exit(1);
                }
            });
    } else if (command === 'client') {
        program.description('generate a typed client from mesh.json')
            .option('--descriptor <path>', 'path to descriptor')
            .option('--out <path>', 'output path')
            .option('--descriptor-out <path>', 'output descriptor path')
            .allowUnknownOption(false)
            .action(async () => {
                process.exit(await run(rest));
            });
    } else if (command === 'publish') {
        program.description('publish this checkout to a catalog')
            .option('--bootstrap <nodes>', 'comma-separated bootstrap nodes')
            .option('--token <token>', 'api token')
            .option('--descriptor <path>', 'path to descriptor')
            .option('--publisher <id>', 'publisher organization id')
            .option('--repository <url>', 'repository url')
            .option('--timeout <ms>', 'timeout in milliseconds')
            .allowUnknownOption(false)
            .action(async () => {
                const { run_ } = await import('../dist/api/publish-cli.js');
                process.exit(await run_(rest));
            });
    } else if (command === 'dev') {
        program.description('serve this part on a dev page')
            .option('--descriptor <path>', 'path to descriptor', 'mesh.json')
            .option('--no-serve', 'do not serve the dev page')
            .option('--port <port>', 'port to serve on', '8080')
            .allowUnknownOption(false)
            .action(async (opts) => {
                const root = process.cwd();
                const descriptor = parseDescriptor(readFileSync(opts.descriptor, 'utf8'));

                const { dir, files, warnings } = await writeDevPage(root, descriptor);
                for (const warning of warnings) process.stderr.write(`note: ${warning}\n`);
                process.stdout.write(`${String(files.length)} file(s) in ${dir}\n`);

                if (!opts.noServe) {
                    const url = await serveDev(dir, Number(opts.port));
                    process.stdout.write(`\n  ${url}\n\nCtrl-C to stop.\n`);
                } else {
                    process.exit(0);
                }
            });
    }

    program.parse([process.argv[0], process.argv[1], ...rest]);
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
