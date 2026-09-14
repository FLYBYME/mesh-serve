import readline from 'node:readline';

import { restClient } from './client.js';
import { ensureDescriptor } from './ensureDescriptor.js';
import { buildProgram } from './commandTree.js';
import { dispatchMeta } from './dispatchMeta.js';
import { metaCommands, findMetaCommand } from './commands/index.js';
import type { Session } from './session.js';
import type { MetaCommandContext } from './metaCommand.js';

function printResult(result: unknown): void {
    console.log(JSON.stringify(result, null, 2));
}

export async function startRepl(session: Session): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${session.apiHost}> `,
    });

    const ctx: MetaCommandContext = { session, rl, commands: metaCommands, client: restClient };

    // Non-fatal: a server may not exist yet (that's what "start" is for), so the REPL has to come up
    // regardless of whether one is currently reachable.
    try {
        const descriptor = await ensureDescriptor(session, restClient);
        console.log(`Connected to ${session.apiHost} -- ${descriptor.calls.length} calls available. Type "help" or "exit".`);
    } catch {
        console.log(`No server reachable at ${session.apiHost} yet. Type "start" to run one, "switch" to point elsewhere, or "help".`);
    }
    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();

        try {
            if (trimmed === '') {
                // fall through to prompt again
            } else {
                const [name, ...rest] = trimmed.split(/\s+/);
                const meta = name !== undefined ? findMetaCommand(name) : undefined;

                if (meta !== undefined) {
                    await dispatchMeta(meta, rest, ctx);
                } else {
                    const current = await ensureDescriptor(session, restClient);
                    const program = buildProgram(session, current, restClient, (_call, result) => printResult(result));
                    await program.parseAsync(trimmed.split(/\s+/), { from: 'user' });
                }
            }
        } catch (err) {
            const isCommanderExit = typeof err === 'object' && err !== null && 'code' in err
                && typeof (err as { code: unknown }).code === 'string'
                && (err as { code: string }).code.startsWith('commander.');
            if (!isCommanderExit) {
                console.error(err instanceof Error ? err.message : String(err));
            }
        }

        rl.prompt();
    });

    rl.on('close', () => {
        console.log('Goodbye.');
        process.exit(0);
    });
}
