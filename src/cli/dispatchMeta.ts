import { z } from 'zod';

import type { MetaCommand, MetaCommandContext } from './metaCommand.js';

/**
 * `--flag value` pairs off the remaining tokens, for a command whose input is an object (named
 * fields, like start's --nodeID/--apiPort). A flag with no following value (or followed by another
 * flag) is treated as boolean-ish `"true"`; coercing that into a real type is the schema's job
 * (z.coerce.number(), z.coerce.boolean(), ...), not this parser's.
 */
function parseFlags(tokens: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined || !token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            result[key] = next;
            i++;
        } else {
            result[key] = 'true';
        }
    }
    return result;
}

/**
 * Parses raw REPL/argv tokens through a meta command's own zod input schema and runs it. An object
 * schema reads `--flag value` pairs; anything else (a bare string, e.g. login's token) reads the
 * whole remaining line as one value. A validation failure prints zod's own message rather than
 * throwing, since a mistyped command is the normal case, not an exceptional one.
 */
export async function dispatchMeta(command: MetaCommand, tokens: readonly string[], ctx: MetaCommandContext): Promise<void> {
    if (command.input === undefined) {
        await command.run(undefined, ctx);
        return;
    }

    const raw = command.input instanceof z.ZodObject ? parseFlags(tokens) : tokens.join(' ');

    let input: unknown;
    try {
        input = command.input.parse(raw);
    } catch (err) {
        if (err instanceof z.ZodError) {
            console.error(err.issues.map((issue) => issue.message).join('; '));
            return;
        }
        throw err;
    }

    await command.run(input, ctx);
}
