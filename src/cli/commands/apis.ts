import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';
import { ApiError, callApi } from '../core/apiClient.js';
import { isLive, readSession } from '../core/session.js';

interface ApiRow {
    readonly id: string;
    readonly apiHost: string;
    readonly description?: string;
}

/**
 * Lists every api the signed-in operator can `switch` to, from `serve.api.find` on whichever api
 * is current -- the same call the console's own api-management screen would make.
 *
 * `switch <url>` already exists for going *to* one, but it needs the hostname up front, and
 * nothing before this told you what hostnames existed at all short of asking someone or reading a
 * database directly. Read-only, so it costs nothing to run before deciding.
 */
export class ApisCommand extends BaseCommand {
    public readonly name = 'apis';
    public readonly description = 'List every api the current account can switch to';

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description)
            .action(async () => { await this.execute(); });
    }

    protected async execute(): Promise<void> {
        const session = await readSession();
        if (session.apiUrl === undefined) {
            this.logger.error('Not pointed at an api. Run `mesh-serve switch <url>` first.');
            process.exitCode = 1;
            return;
        }
        if (!isLive(session)) {
            this.logger.error('No live ticket. Run `mesh-serve login` first.');
            process.exitCode = 1;
            return;
        }

        const findCall = session.descriptor?.calls.find((c) => c.key === 'serve.api.find');
        if (findCall === undefined) {
            this.logger.error(`serve.api.find is not exposed on ${session.descriptor?.host ?? session.apiUrl} -- switch to the management api to list others.`);
            process.exitCode = 1;
            return;
        }

        let rows: ApiRow[];
        try {
            rows = await callApi(session.apiUrl, findCall, {}, session.token) as ApiRow[];
        } catch (err) {
            if (err instanceof ApiError) {
                this.logger.error(err.message);
                process.exitCode = 1;
                return;
            }
            throw err;
        }

        if (rows.length === 0) {
            this.logger.info('No apis found for this account\'s organization.');
            return;
        }

        for (const row of rows) {
            const here = row.apiHost === session.descriptor?.host ? '  <- current' : '';
            const desc = row.description !== undefined && row.description.length > 0 ? `  (${row.description})` : '';
            console.log(`${row.apiHost}${desc}${here}`);
        }
        console.log('\nSwitch with: mesh-serve switch http://<host>:<port>');
    }
}
