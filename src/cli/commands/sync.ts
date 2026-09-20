import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { syncSpec } from '../../sync.js';
import { DEFAULT_SITE_PATH } from '../../console.site.js';
import { readSession, isLive } from '../core/session.js';

const syncInputSchema = z.object({
    site: z.string().default(DEFAULT_SITE_PATH).describe('Path to a *.site.yaml (or *.site.json) spec'),
    out: z.string().optional().describe('Write the site\'s generated client here -- omit to skip client generation'),
    force: z.boolean().default(false).describe('Rebuild every part even if a successful artifact is already cached'),
});

/**
 * Applies a site spec to whichever api `mesh-serve login`/`switch` currently point at: reconciles
 * repos, parts, artifacts, the composition, the site, and the api's own exposure to match what the
 * spec declares.
 *
 * An ordinary api client, like every other command here except `bootstrap` -- `sync.ts` (this
 * command's real implementation) makes every one of its calls through the api, with the currently
 * signed-in operator's own ticket, the same as a discovered command or a browser would. It used to
 * connect to the mesh directly; that was wrong for the same reason `syncAdmin` and a raw
 * `serve.artifact.build` were wrong before it -- a shortcut around the one gate everything else
 * here goes through.
 */
export class SyncCommand extends BaseCommand {
    public readonly name = 'sync';
    public readonly description = 'Apply a site spec through the currently signed-in api';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, syncInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(syncInputSchema.parse(ZodToCliMapper.parseOptions(opts, syncInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof syncInputSchema>): Promise<void> {
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

        await syncSpec(args.site, args.out, args.force);
    }
}
