import type { MetaCommand } from '../metaCommand.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import { switchCommand } from './switch.js';
import { refreshCommand } from './refresh.js';
import { generateCommand } from './generate.js';
import { startCommand } from './start.js';
import { helpCommand } from './help.js';
import { exitCommand } from './exit.js';

export const metaCommands: readonly MetaCommand[] = [
    loginCommand,
    logoutCommand,
    switchCommand,
    refreshCommand,
    generateCommand,
    startCommand,
    helpCommand,
    exitCommand,
];

export function findMetaCommand(name: string): MetaCommand | undefined {
    return metaCommands.find((command) => command.name === name || command.aliases?.includes(name));
}
