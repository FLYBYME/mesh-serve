import type { MetaCommand } from '../metaCommand.js';

export const helpCommand: MetaCommand = {
    name: 'help',
    description: 'Show this message',
    run(_input, { session, commands }) {
        console.log('Meta commands:');
        for (const command of commands) {
            const names = [command.name, ...(command.aliases ?? [])].join('/');
            console.log(`  ${names.padEnd(12)} ${command.description}`);
        }
        console.log('');
        console.log('Anything else is run as "<domain> <action> [--flag value...]" -- add --help to any of those for its flags.');
        console.log('');
        console.log(`Connected to ${session.apiHost} -- ${session.descriptor?.calls.length ?? 0} calls available.`);
    },
};
