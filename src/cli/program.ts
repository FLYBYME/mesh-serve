import { Command } from 'commander';

import { CommandRegistry } from './core/CommandRegistry.js';
import { attachDynamicCommands } from './dynamic.js';
import { LoginCommand } from './commands/login.js';
import { ClaimCommand } from './commands/claim.js';
import { LogoutCommand } from './commands/logout.js';
import { SwitchCommand } from './commands/switch.js';
import { RefreshCommand } from './commands/refresh.js';
import { GenerateCommand } from './commands/generate.js';
import { InitCommand } from './commands/init.js';
import { PublishCommand } from './commands/publish.js';
import { StartCommand } from './commands/start.js';
import { HelpCommand } from './commands/help.js';
import { ExitCommand, type ReplHandle } from './commands/exit.js';
import type { Session } from './session.js';

/**
 * A fresh Commander program every call: the fixed baseline (login, switch, generate...) plus
 * whatever the current host exposes right now, fetched live and attached as a `domain action
 * [--flag value...]` tree alongside it -- rebuilt rather than kept around so a long-lived REPL never
 * carries stale subcommands (or stale Commander option state) from before the last `switch`/`login`,
 * the same reasoning the old dynamic CLI's per-invocation `buildProgram` used.
 */
export async function buildProgram(session: Session, replHandle: ReplHandle): Promise<{ program: Command; registry: CommandRegistry }> {
    const program = new Command();
    program
        .name('mesh-serve')
        .description('mesh-serve -- sign in, switch hosts, render typed clients, and start a node.')
        .exitOverride();

    const registry = new CommandRegistry();

    const commands = [
        new LoginCommand(session),
        new ClaimCommand(session),
        new LogoutCommand(session),
        new SwitchCommand(session),
        new RefreshCommand(session),
        new GenerateCommand(session),
        new InitCommand(session),
        new PublishCommand(session),
        new StartCommand(),
        new ExitCommand(replHandle),
    ];
    const helpCommand = new HelpCommand(registry, program, session);

    for (const command of [...commands, helpCommand]) {
        registry.register(command);
    }
    registry.attachToProgram(program);

    await attachDynamicCommands(program, session);

    return { program, registry };
}
