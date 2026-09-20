#!/usr/bin/env node
import { Command } from 'commander';

import { StartCommand } from './commands/start.js';
import { BootstrapCommand } from './commands/bootstrap.js';
import { GenerateCommand } from './commands/generate.js';
import { LoginCommand } from './commands/login.js';
import { SwitchCommand } from './commands/switch.js';
import { registerDiscoveredCommands } from './core/dynamicCommands.js';
import { readSession } from './core/session.js';

/**
 * The one entry point behind the `mesh-serve` binary.
 *
 * Two kinds of command, and the split is the whole design. **Built-ins** are about this machine and
 * this cluster: `start` boots a node, `bootstrap` claims one, `generate` renders a typed client for
 * a repo checked out on disk, and `login`/`switch` decide who and where. They exist regardless of
 * what the CLI is pointed at. **Discovered** commands come from whichever api `switch` selected,
 * read from its own `_describe`.
 *
 * `bootstrap` is the only thing here that touches the mesh network directly, because its job is to
 * create the gate everything else goes through -- it says so itself. Past that point the CLI is an
 * ordinary api client with no privileged path, subject to the same `serve.expose` rows and
 * permission floors as a browser. That is deliberate: it makes an incomplete api impossible not to
 * notice, because the CLI cannot route around it either.
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
