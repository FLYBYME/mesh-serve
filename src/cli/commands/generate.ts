import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { ApiError, callApi } from '../core/apiClient.js';
import { isLive, readSession } from '../core/session.js';

const generateInputSchema = z.object({
    api: z.string().describe('The serve.api id to render a typed client for -- not necessarily the api you are currently switched to'),
    out: z.string().default('./generated/api.ts').describe('Where to write the generated client'),
});

/**
 * Renders one api's full current typed client -- the same `serve.api.generateClient` contract the
 * api itself exposes, called here as the currently signed-in operator, the same way a browser or
 * any other discovered command would. There is no client-side narrowing file to go stale against
 * the server's own state -- this always renders exactly what the api currently exposes.
 *
 * Used to connect to the mesh directly on the reasoning that an operator running this already had
 * that trust, the same as `bootstrap`. That reasoning does not actually hold once a real api
 * exists: `serve.api.generateClient` is an ordinary operator-gated call, not something that needs
 * to skip the gate it is itself exposed behind. Sign in first (`mesh-serve login`) and be pointed
 * at an api that exposes it (`mesh-serve switch`) -- the management api does, by default.
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'Render an api\'s full current typed client, through the currently signed-in api';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, generateInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(generateInputSchema.parse(ZodToCliMapper.parseOptions(opts, generateInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof generateInputSchema>): Promise<void> {
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

        const found = session.descriptor?.calls.find((c) => c.key === 'serve.api.generateClient');
        if (found === undefined) {
            this.logger.error(`serve.api.generateClient is not exposed on ${session.descriptor?.host ?? session.apiUrl}. Switch to the management api.`);
            process.exitCode = 1;
            return;
        }

        let result: { source: string };
        try {
            result = await callApi(session.apiUrl, found, { apiId: args.api }, session.token) as { source: string };
        } catch (err) {
            if (err instanceof ApiError) {
                this.logger.error(err.message);
                process.exitCode = 1;
                return;
            }
            throw err;
        }

        await fs.mkdir(path.dirname(args.out), { recursive: true });
        await fs.writeFile(args.out, result.source);
        this.logger.info(`Wrote ${args.out} (${result.source.length} bytes).`);
    }
}
