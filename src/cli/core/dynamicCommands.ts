import type { Command } from 'commander';

import { ApiError, callApi } from './apiClient.js';
import { JsonSchemaToCli } from './JsonSchemaToCli.js';
import { isLive, type Session } from './session.js';

/**
 * Turns the api's own described surface into commands.
 *
 * The CLI has two kinds of command and they must not be confused. The built-ins (`start`,
 * `bootstrap`, `login`, `switch`, `generate`) are about this machine and this cluster; they exist
 * whatever the CLI is pointed at. Everything else comes from whichever api `switch` selected, which
 * is why the same binary offers `serve.cdn.create` against `api.localhost` and does not offer it at
 * all against an application gate. Absent, not forbidden.
 *
 * Read from the cached descriptor rather than fetched per invocation, so `--help` works offline and
 * a command does not pay a round trip before it starts. `switch` (and `login`) refresh the cache;
 * `_describe`'s `shapeHash` is what tells you whether that changed anything.
 */

/** Built-in names the api must never shadow, however an expose row is spelled. */
const RESERVED = new Set(['start', 'bootstrap', 'generate', 'sync', 'login', 'switch', 'apis', 'help']);

function renderResult(value: unknown): void {
    if (value === undefined) {
        console.log('ok');
        return;
    }
    if (typeof value === 'string') {
        console.log(value);
        return;
    }
    console.log(JSON.stringify(value, null, 2));
}

export function registerDiscoveredCommands(program: Command, session: Session): void {
    const descriptor = session.descriptor;
    if (descriptor === undefined || session.apiUrl === undefined) return;

    const apiUrl = session.apiUrl;

    for (const call of descriptor.calls) {
        if (RESERVED.has(call.key)) continue;

        const input = (call.input ?? {}) as Parameters<typeof JsonSchemaToCli.applyOptions>[1];
        const summary = [
            call.description,
            call.destructive === true ? '[destructive]' : undefined,
            call.gate === 'public' ? undefined : `[${call.gate}]`,
        ].filter((part) => part !== undefined).join(' ');

        const sub = program
            .command(call.key)
            .description(summary)
            .addHelpText('after', `\n  ${call.method} ${descriptor.base}${call.path}  on ${descriptor.host}`);

        JsonSchemaToCli.applyOptions(sub, input);
        sub.option('--json <object>', 'The whole input as one JSON object, instead of the flags');
        if (JsonSchemaToCli.takesOnlyJson(input)) {
            sub.addHelpText('after', '\n  This call\'s input has more than one shape: pass it whole with --json \'{...}\'.');
        }

        sub.action(async (opts: Record<string, unknown>) => {
            const { json, ...flags } = opts;
            let params: Record<string, unknown>;
            if (typeof json === 'string') {
                // Not merged with flags: which one would win is a guess, and a wrong guess is a wrong call.
                const others = Object.keys(flags).filter((key) => flags[key] !== undefined);
                if (others.length > 0) {
                    console.error(`--json is the whole input; drop ${others.map((key) => `--${key}`).join(', ')} or put them inside it.`);
                    process.exitCode = 1;
                    return;
                }
                try {
                    params = JsonSchemaToCli.parseJsonInput(json);
                } catch (err) {
                    console.error(err instanceof Error ? err.message : String(err));
                    process.exitCode = 1;
                    return;
                }
            } else {
                params = JsonSchemaToCli.parseOptions(flags, input);
            }

            // Checked here so all of them are named at once, before a round trip. The server
            // validates too and owns the real schema -- this is about the message, not the rule.
            const missing = JsonSchemaToCli.missingRequired(params, input);
            if (missing.length > 0) {
                console.error(`Missing required option(s): ${missing.map((key) => `--${key}`).join(', ')}`);
                process.exitCode = 1;
                return;
            }

            // A gated call with no live ticket fails at the api as a 401. Saying so here names the
            // fix instead, since "run login" is not something a status code can tell you.
            if (call.gate !== 'public' && !isLive(session)) {
                console.error(`"${call.key}" requires ${call.gate}, and there is no live ticket. Run \`mesh-serve login\`.`);
                process.exitCode = 1;
                return;
            }

            try {
                renderResult(await callApi(apiUrl, call, params, session.token));
            } catch (err) {
                if (err instanceof ApiError) {
                    console.error(err.message);
                    if (err.status === 401) console.error('Run `mesh-serve login` and try again.');
                    if (err.status === 403) console.error(`That call requires ${call.gate} in this api's organization.`);
                    process.exitCode = 1;
                    return;
                }
                throw err;
            }
        });
    }
}
