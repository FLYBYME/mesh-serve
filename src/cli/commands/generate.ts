import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi } from '../resolveApi.js';
import type { Session } from '../session.js';

interface GenerateArgs {
    readonly api?: string;
    readonly out: string;
}

/**
 * Deliberately no narrowing input -- always the api's full current exposure. A local wants file was
 * a second input besides live server state, which meant two things had to agree for a regenerate to
 * be correct rather than one: the api's actual exposure, and whether the file was still accurate.
 * Dropped so this is what it should already be -- pull from the api, get the same file every time
 * nothing on the server has changed. What a site actually exposes is real, deliberate configuration
 * (serve.expose.add), not something a client-side file should be narrowing on its own say-so.
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'generate [--api <id>] [--out file]: render this app\'s typed client from an api\'s full current exposure';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .option('--api <id>', 'The serve.api id to render a client for -- defaults to the api you\'re logged into')
            .option('--out <file>', 'Where to write the generated client', './generated/api.ts')
            .action(async (opts: { api?: string; out: string }) => this.execute(opts));
    }

    protected async execute({ api, out }: GenerateArgs): Promise<void> {
        const loginClient = buildClient(this.session);
        let source: string;
        try {
            const { apiId, apiHost } = await resolveApi(loginClient, this.session, { api });
            try {
                await loginClient.call('serve.expose.add', { apiId, contract: 'serve.api.generateClient', role: 'operator' });
            } catch (err) {
                if (!(err instanceof MeshCallError && err.error.kind === 'conflict')) throw err;
            }

            // See resolveApi's own comment: the call below has to hit the *target* api, which may
            // differ from the one this session is logged into.
            const client = buildClient({ apiHost, credential: this.session.credential });
            const result = await client.call('serve.api.generateClient', { apiId });
            source = result.source;
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        }

        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, source);
        this.logger.info(`Wrote ${out} (${source.length} bytes).`);
    }
}
