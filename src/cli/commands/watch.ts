import type { Command as CommanderCommand } from 'commander';
import { createFetchEventSource } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { describeApi } from '../core/apiClient.js';
import { isLive, readSession } from '../core/session.js';

interface WatchOptions {
    readonly json?: boolean;
}

/**
 * Streams the current api's events to the terminal as they happen -- a part starting or failing on
 * some node, a build finishing -- over the same `/api/events` subscription a browser uses.
 *
 * Watching a deploy used to mean SSHing into each node and reading its journal. This is the same
 * information, from the platform itself, gated like everything else it serves.
 */
export class WatchCommand extends BaseCommand {
    public readonly name = 'watch';
    public readonly description = 'Stream the current api\'s events (all it exposes, or the ones named) until interrupted';

    public register(program: CommanderCommand): void {
        program.command(this.name)
            .description(this.description)
            .argument('[events...]', 'Event names, e.g. serve.part.started serve.part.failed (default: every event the api streams)')
            .option('--json', 'Print each event as one raw JSON line')
            .action(async (events: string[], options: WatchOptions) => { await this.execute(events, options); });
    }

    protected async execute(requested: string[] = [], options: WatchOptions = {}): Promise<void> {
        const session = await readSession();
        if (session.apiUrl === undefined) {
            this.logger.error('Not pointed at an api. Run `mesh-serve switch <url>` first.');
            process.exitCode = 1;
            return;
        }
        const apiUrl = session.apiUrl;

        // What this api streams right now -- the cached descriptor predates events and may be stale.
        const descriptor = await describeApi(apiUrl);
        const streamed = (descriptor.events ?? []).map((event) => event.name);
        const names = requested.length > 0 ? requested : streamed;
        if (names.length === 0) {
            this.logger.error(`${descriptor.host} streams no events. An operator exposes one with serve.expose.add --kind event.`);
            process.exitCode = 1;
            return;
        }

        const query = requested.length > 0 ? `?events=${encodeURIComponent(requested.join(','))}` : '';
        const token = isLive(session) ? session.token : undefined;
        const source = createFetchEventSource(`${apiUrl.replace(/\/+$/, '')}/api/events${query}`, {
            headers: (): Record<string, string> => (token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        });

        const print = (event: string, data: string | undefined): void => {
            if (options.json) {
                console.log(JSON.stringify({ at: new Date().toISOString(), event, data: parse(data) }));
                return;
            }
            console.log(`${new Date().toISOString().slice(11, 19)}  ${event}  ${describe(parse(data))}`);
        };

        source.addEventListener('open', () => {
            if (!options.json) console.error(`watching ${names.join(', ')} on ${descriptor.host}`);
        });
        for (const name of names) {
            source.addEventListener(name, (event) => print(name, event.data));
        }
        source.addEventListener('subscription.omitted', (event) => {
            const omitted = parse(event.data);
            console.error(`not watching: ${describe(omitted)}`);
        });
        source.addEventListener('subscription.closed', (event) => {
            console.error(`closed by the api: ${describe(parse(event.data))}`);
            process.exitCode = 1;
            source.close();
        });
        source.addEventListener('error', (event) => {
            console.error(`${event.data ?? 'connection error'}`);
        });
        // A refusal (403/404) is final: the source has already stopped retrying.
        source.addEventListener('close', () => {
            process.exitCode = 1;
        });
        if (token === undefined) {
            console.error('No live ticket -- watching anonymously. Run `mesh-serve login` for gated events.');
        }
    }
}

function parse(data: string | undefined): unknown {
    if (data === undefined) return undefined;
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/** `key=value` for each top-level field; anything nested stays compact JSON. */
function describe(value: unknown): string {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return JSON.stringify(value);
    return Object.entries(value)
        .map(([key, field]) => `${key}=${typeof field === 'string' ? field : JSON.stringify(field)}`)
        .join(' ');
}
