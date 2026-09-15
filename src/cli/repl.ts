import readline from 'node:readline';
import type { Command } from 'commander';

import type { Session } from './session.js';
import type { ReplHandle } from './commands/exit.js';

function isCommanderExit(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
        && typeof (err as { code: unknown }).code === 'string'
        && (err as { code: string }).code.startsWith('commander.');
}

/**
 * Re-parses each line through the same fixed Commander program the one-shot path uses -- there is no
 * dynamic domain.action tree to rebuild per line any more (that lived on a cached descriptor, gone
 * with it), so reusing one program instance across lines is safe: nothing here keeps option state
 * between actions.
 */
export async function startRepl(session: Session, program: Command, handle: ReplHandle): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${session.apiHost}> `,
    });
    handle.rl = rl;

    console.log(`mesh-serve -- connected to ${session.apiHost}. Type "help" or "exit".`);
    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (trimmed !== '') {
            try {
                await program.parseAsync(trimmed.split(/\s+/), { from: 'user' });
            } catch (err) {
                if (!isCommanderExit(err)) {
                    console.error(err instanceof Error ? err.message : String(err));
                }
            }
        }
        rl.prompt();
    });

    rl.on('close', () => {
        console.log('Goodbye.');
        process.exit(0);
    });
}
