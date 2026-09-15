#!/usr/bin/env node
import { Command } from 'commander';

import { CommandRegistry } from './core/CommandRegistry.js';
import { createSession } from './session.js';
import { startRepl } from './repl.js';
import { LoginCommand } from './commands/login.js';
import { LogoutCommand } from './commands/logout.js';
import { SwitchCommand } from './commands/switch.js';
import { RefreshCommand } from './commands/refresh.js';
import { GenerateCommand } from './commands/generate.js';
import { StartCommand } from './commands/start.js';
import { HelpCommand } from './commands/help.js';
import { ExitCommand, type ReplHandle } from './commands/exit.js';

function isCommanderExit(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
        && typeof (err as { code: unknown }).code === 'string'
        && (err as { code: string }).code.startsWith('commander.');
}

/**
 * The one entry point behind the `mesh-serve` binary. A fixed command set (login, switch, generate,
 * start...), each one a real BaseCommand talking through the same typed client every other consumer
 * uses -- never a dynamic domain.action tree scanned off a live server, which is what this replaced.
 */
async function main(): Promise<void> {
    const session = await createSession();

    const program = new Command();
    program
        .name('mesh-serve')
        .description('mesh-serve -- sign in, switch hosts, render typed clients, and start a node.')
        .exitOverride();

    const registry = new CommandRegistry();
    const replHandle: ReplHandle = {};

    const commands = [
        new LoginCommand(session),
        new LogoutCommand(session),
        new SwitchCommand(session),
        new RefreshCommand(session),
        new GenerateCommand(session),
        new StartCommand(),
        new ExitCommand(replHandle),
    ];
    const helpCommand = new HelpCommand(registry, program, session);

    for (const command of [...commands, helpCommand]) {
        registry.register(command);
    }
    registry.attachToProgram(program);

    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        await startRepl(session, program, replHandle);
        return;
    }

    try {
        await program.parseAsync(argv, { from: 'user' });
    } catch (err) {
        if (!isCommanderExit(err)) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
