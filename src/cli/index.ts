#!/usr/bin/env node
import { Command } from 'commander';

import { StartCommand } from './commands/start.js';
import { BootstrapCommand } from './commands/bootstrap.js';

/**
 * The one entry point behind the `mesh-serve` binary. Used to be a fixed command set (login,
 * switch, generate...) plus a live `domain action` tree fetched from whatever host the CLI was
 * pointed at -- all of that got deleted (see roadmap.md) in favor of rebuilding the CLI surface
 * from a clean slate. `start` boots a node; `bootstrap` claims one; everything else (login and
 * beyond) is rebuilt from here as it's needed, going through the api like an ordinary caller.
 */
async function main(): Promise<void> {
    const program = new Command();
    program
        .name('mesh-serve')
        .description('mesh-serve -- start a node, or claim a fresh one.')
        .exitOverride();

    new StartCommand().register(program);
    new BootstrapCommand().register(program);

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
