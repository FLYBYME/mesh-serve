#!/usr/bin/env node
import { createSession } from './session.js';
import { startRepl } from './repl.js';
import { buildProgram } from './program.js';
import type { ReplHandle } from './commands/exit.js';

function isCommanderExit(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
        && typeof (err as { code: unknown }).code === 'string'
        && (err as { code: string }).code.startsWith('commander.');
}

/**
 * The one entry point behind the `mesh-serve` binary: a fixed command set (login, switch, generate,
 * start...) plus a live `domain action` tree fetched from whatever the current host exposes -- see
 * program.ts.
 */
async function main(): Promise<void> {
    const session = await createSession();
    const replHandle: ReplHandle = {};

    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        await startRepl(session, replHandle);
        return;
    }

    const { program } = await buildProgram(session, replHandle);
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
