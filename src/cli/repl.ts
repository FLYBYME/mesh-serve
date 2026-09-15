import readline from 'node:readline';

import { buildProgram } from './program.js';
import type { Session } from './session.js';
import type { ReplHandle } from './commands/exit.js';

function isCommanderExit(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
        && typeof (err as { code: unknown }).code === 'string'
        && (err as { code: string }).code.startsWith('commander.');
}

/**
 * Rebuilds the program fresh for every line -- see program.ts for why. That also means each line
 * re-fetches the current host's live exposure, so a `switch` or `login` earlier in the same REPL
 * session is reflected on the very next line, not just on restart.
 *
 * Reads lines via the async iterator rather than `rl.on('line', ...)`: an event listener fires for
 * every buffered line without waiting for the previous handler's async work, so three piped lines
 * ("identity whoami", "help", "exit") ran concurrently and "exit" closed the interface before the
 * first two printed anything -- caught live piping a scripted REPL session, the same class of bug
 * `prompt.ts`'s `question()` had. `for await` pulls one line at a time and only asks for the next
 * once the current one's `await`s are done, which serializes it for free.
 */
export async function startRepl(session: Session, handle: ReplHandle): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${session.apiHost}> `,
    });
    handle.rl = rl;

    console.log(`mesh-serve -- connected to ${session.apiHost}. Type "help" or "exit".`);
    rl.prompt();

    for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed !== '') {
            try {
                const { program } = await buildProgram(session, handle);
                await program.parseAsync(trimmed.split(/\s+/), { from: 'user' });
            } catch (err) {
                if (!isCommanderExit(err)) {
                    console.error(err instanceof Error ? err.message : String(err));
                }
            }
        }
        rl.prompt();
    }

    console.log('Goodbye.');
    process.exit(0);
}
