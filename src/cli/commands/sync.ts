import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { syncSpec } from '../../sync.js';
import { DEFAULT_SITE_PATH } from '../../console.site.js';

const syncInputSchema = z.object({
    site: z.string().default(DEFAULT_SITE_PATH).describe('Path to a *.site.yaml (or *.site.json) spec'),
    out: z.string().optional().describe('Write the site\'s generated client here -- omit to skip client generation'),
    force: z.boolean().default(false).describe('Rebuild every part even if a successful artifact is already cached'),
    bootstrapNode: z.string().default('ws://127.0.0.1:6005').describe('ws:// URL of a running, already-claimed node'),
    sharedKey: z.string().optional().describe('Shared secret that node\'s mesh network requires -- also read from MESH_KEY if unset'),
});

/**
 * Applies a site spec to a cluster: reconciles repos, parts, artifacts, the composition, the site,
 * and the api's exposure to match what the spec declares.
 *
 * Connects to the mesh directly, the same trust `bootstrap` and `generate` already assume -- not
 * because this needs privileges the api couldn't grant an operator (it doesn't; every individual
 * step here is something `serve.repo.create`/`serve.part.create`/`serve.artifact.requestBuild`/etc
 * already let an operator do over the api), but because this is many such calls in sequence and
 * connecting once, directly, is what lets it read back what it just wrote without a login step
 * in between. `sync.ts` (this command's real implementation) is the specification other tooling can
 * follow to do the same thing piece by piece over the api instead, which is exactly how bootstrap
 * itself is meant to be exercised afterward.
 *
 * Previously only reachable as `npx tsx src/sync.ts` -- a real gap, since anyone running the
 * compiled binary (an ordinary install, not a checkout) had no way to run it at all.
 */
export class SyncCommand extends BaseCommand {
    public readonly name = 'sync';
    public readonly description = 'Apply a site spec to an already-claimed cluster';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, syncInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(syncInputSchema.parse(ZodToCliMapper.parseOptions(opts, syncInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof syncInputSchema>): Promise<void> {
        await syncSpec(args.site, args.out, args.force, {
            bootstrapNode: args.bootstrapNode,
            sharedKey: args.sharedKey,
        });
    }
}
