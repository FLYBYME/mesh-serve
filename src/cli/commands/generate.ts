import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { renderClient } from '../../api/methods/generateClient.js';
import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { ApiError, callApi, describeApi } from '../core/apiClient.js';
import { isLive, readSession, type Session } from '../core/session.js';

const generateInputSchema = z.object({
    api: z.string().optional().describe('The serve.api id to render a typed client for -- not necessarily the api you are currently switched to'),
    host: z.string().optional().describe('Or the api by hostname, e.g. api.surfdns.net -- then no session is needed at all'),
    out: z.string().default('./generated/api.ts').describe('Where to write the generated client'),
});

/**
 * Renders one api's full current typed client **here**, with this installed mesh-serve.
 *
 * The api supplies only facts: its public `/api/_describe` (every exposed call, its JSON Schemas,
 * its gate, the exposure and shape hashes -- the same descriptor the server renders from). Turning
 * them into TypeScript happens on this machine, in `renderClient`, the one renderer the server's
 * `serve.api.generateClient` uses too.
 *
 * It used to ask the server to render. Then a fix to the renderer did nothing for anyone until
 * every node was upgraded -- the typed input fix (918e503) sat unusable for exactly that reason.
 * Now a renderer fix takes effect with a mesh-serve dependency bump and a re-run.
 *
 * `--host` needs no session: `_describe` is public. `--api <id>` resolves the id to its host
 * through the current api (`serve.api.resolveById`, also ungated).
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'Render an api\'s full current typed client locally, from its public description';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, generateInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(generateInputSchema.parse(ZodToCliMapper.parseOptions(opts, generateInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof generateInputSchema>): Promise<void> {
        const session = await readSession();

        let host: string;
        try {
            if (args.host !== undefined) {
                host = args.host;
            } else if (args.api !== undefined) {
                host = await this.hostOf(args.api, session);
            } else {
                this.logger.error('Name the api: --host <hostname>, or --api <serve.api id>.');
                process.exitCode = 1;
                return;
            }
        } catch (err) {
            if (err instanceof ApiError) {
                this.logger.error(err.message);
                process.exitCode = 1;
                return;
            }
            throw err;
        }

        let descriptor;
        try {
            descriptor = await describeApi(this.urlOf(host, session));
        } catch (err) {
            if (err instanceof ApiError) {
                this.logger.error(err.message);
                process.exitCode = 1;
                return;
            }
            throw err;
        }

        const source = renderClient(descriptor.host, descriptor);
        await fs.mkdir(path.dirname(args.out), { recursive: true });
        await fs.writeFile(args.out, source);
        this.logger.info(`Wrote ${args.out} (${source.length} bytes, ${descriptor.calls.length} calls from ${descriptor.host}).`);
    }

    /** An api id's hostname, asked of the current api. */
    private async hostOf(apiId: string, session: Session): Promise<string> {
        if (session.apiUrl === undefined) {
            throw new ApiError('Not pointed at an api to resolve --api through. Run `mesh-serve switch <url>`, or pass --host.', 0, '');
        }
        const resolve = session.descriptor?.calls.find((c) => c.key === 'serve.api.resolveById');
        if (resolve === undefined) {
            throw new ApiError(`serve.api.resolveById is not exposed on ${session.descriptor?.host ?? session.apiUrl}; pass --host instead.`, 0, session.apiUrl);
        }
        const api = await callApi(session.apiUrl, resolve, { id: apiId }, isLive(session) ? session.token : undefined);
        if (typeof api !== 'object' || api === null || !('apiHost' in api) || typeof api.apiHost !== 'string') {
            throw new ApiError(`serve.api.resolveById answered without an apiHost for ${apiId}.`, 0, session.apiUrl);
        }
        return api.apiHost;
    }

    /**
     * Where a host's description lives. The current api's own url when it is that host (which also
     * covers a local `http://api.localhost:…` session); otherwise https.
     */
    private urlOf(host: string, session: Session): string {
        if (/^https?:\/\//.test(host)) return host;
        if (session.apiUrl !== undefined && session.descriptor?.host === host) return session.apiUrl;
        return `https://${host}`;
    }
}
