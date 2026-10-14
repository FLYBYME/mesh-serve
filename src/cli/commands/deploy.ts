import fs from 'node:fs/promises';
import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { deploy } from '../../deploy/run.js';

const deployInputSchema = z.object({
    site: z.string().optional().describe('The site file (default: the one *.site.yaml in this folder)'),
    go: z.boolean().default(false).describe('Do it. Without it: a dry run that checks everything and changes nothing'),
    force: z.boolean().default(false).describe('Build every part again, even where a build at that ref exists'),
    regenerate: z.boolean().default(false).describe('Write any generated client that no longer matches its api again (then commit, push and deploy)'),
});

/** The one site file in this folder, or a refusal naming what is there. */
async function siteFile(): Promise<string> {
    const found = (await fs.readdir('.')).filter((f) => f.endsWith('.site.yaml'));
    const only = found[0];
    if (found.length === 1 && only !== undefined) return only;

    throw new Error(found.length === 0
        ? 'No *.site.yaml here: name one with --site, or make one with `mesh-serve init`.'
        : `More than one site file here (${found.join(', ')}): name one with --site.`);
}

/**
 * Puts one site on the api the CLI is signed in to, from its site file (`deploy/run.ts` says each
 * step). Replaces `sync` and every site's own scripts/deploy.mjs.
 */
export class DeployCommand extends BaseCommand {
    public readonly name = 'deploy';
    public readonly description = 'Check, build and deploy a site from its *.site.yaml (a dry run unless --go)';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, deployInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(deployInputSchema.parse(ZodToCliMapper.parseOptions(opts, deployInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof deployInputSchema>): Promise<void> {
        try {
            const sitePath = args.site ?? await siteFile();
            const ok = await deploy({ sitePath, go: args.go, force: args.force, regenerate: args.regenerate }, (line) => console.log(line));

            if (!ok) process.exitCode = 1;
        } catch (err) {
            this.logger.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    }
}
