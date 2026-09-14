import type readline from 'node:readline';
import type { z } from 'zod';

import type { Session } from './session.js';
import type { Client } from './client.js';

export interface MetaCommandContext {
    readonly session: Session;
    /** Absent in one-shot mode -- there is no interactive line reader to close. */
    readonly rl?: readline.Interface;
    readonly commands: readonly MetaCommand[];
    readonly client: Client;
}

/**
 * One of the REPL's own fixed commands (login, help, exit...) -- as distinct from a domain.action
 * call, which is never hand-authored and comes back fresh from GET /api/_describe instead
 * (see commandTree.ts). Same spirit as mesh's own BaseCommand (name, description, one entry point),
 * kept as a plain object rather than a class since nothing here needs shared instance state.
 *
 * `input` is real zod, matching every tool contract in this repo -- `run` never sees an unparsed
 * string. Absent means the command takes nothing (help, exit, logout, refresh).
 */
export interface MetaCommand<TInput = unknown> {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly description: string;
    readonly input?: z.ZodType<TInput, z.ZodTypeDef, unknown>;
    run(input: TInput, ctx: MetaCommandContext): Promise<void> | void;
}
