import type { MetaCommand } from '../metaCommand.js';

export const exitCommand: MetaCommand = {
    name: 'exit',
    aliases: ['quit'],
    description: 'Quit the REPL',
    run(_input, { rl }) {
        if (rl !== undefined) {
            rl.close();
        } else {
            process.exit(0);
        }
    },
};
