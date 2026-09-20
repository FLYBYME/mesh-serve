#!/usr/bin/env node
import { Command } from 'commander';

import { StartCommand } from './commands/start.js';
import { BootstrapCommand } from './commands/bootstrap.js';
import { GenerateCommand } from './commands/generate.js';
import { SyncCommand } from './commands/sync.js';
import { LoginCommand } from './commands/login.js';
import { SwitchCommand } from './commands/switch.js';
import { registerDiscoveredCommands } from './core/dynamicCommands.js';
import { readSession } from './core/session.js';

/**
 * The one entry point behind the `mesh-serve` binary.
 *
 * Two kinds of command, and the split is the whole design. **Built-ins** are about this machine and
 * this cluster: `start` boots a node, `bootstrap` claims one, `generate` renders a typed client for
 * a repo checked out on disk, `sync` applies a site spec, and `login`/`switch` decide who and where.
 * They exist regardless of what the CLI is pointed at. **Discovered** commands come from whichever
 * api `switch` selected, read from its own `_describe`.
 *
 * `bootstrap`, `generate` and `sync` are the only things here that touch the mesh network directly
 * -- `bootstrap` because its job is to create the gate everything else goes through, `generate` and
 * `sync` because each is many api-shaped operations in one connected session rather than a login
 * plus a round trip per step. None of the three does anything an operator with the right role
 * couldn't also do over the api one call at a time; `sync.ts` is, in effect, the specification for
 * what a fuller api client would automate. Everything else here -- `login`, `switch`, and every
 * discovered command -- is an ordinary api client with no privileged path, subject to the same
 * `serve.expose` rows and permission floors as a browser. That is deliberate: it makes an
 * incomplete api impossible not to notice, because those commands cannot route around it either.
 */
async function main(): Promise<void> {
    const program = new Command();
    program
        .name('mesh-serve')
        .description('mesh-serve -- start a node, claim a fresh one, or work against an api.')
        .exitOverride();

    new StartCommand().register(program);
    new BootstrapCommand().register(program);
    new GenerateCommand().register(program);
    new SyncCommand().register(program);
    new LoginCommand().register(program);
    new SwitchCommand().register(program);

    // Last, and from cache: a discovered command must never shadow a built-in, and `--help` has to
    // render without a cluster to ask.
    registerDiscoveredCommands(program, await readSession());

    try {
        await program.parseAsync(process.argv.slice(2), { from: 'user' });
    } catch (err) {
        const isCommanderExit = typeof err === 'object' && err !== null && 'code' in err
            && typeof (err as { code: unknown }).code === 'string'
            && (err as { code: string }).code.startsWith('commander.');
        if (!isCommanderExit) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
