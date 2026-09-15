import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import type { Session } from '../session.js';

interface GenerateArgs {
    readonly site: string;
    readonly wants: string;
    readonly out: string;
}

async function readWants(file: string): Promise<string[] | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        throw new Error(`${file} must be a JSON array of contract key strings.`);
    }
    return parsed;
}

/**
 * The local-dev half of "generate a browser-safe client" (the other half is whatever the cdn does
 * at release-build time, against the same serve.api.generateClient call): read this repo's own
 * mesh.wants.json -- the same file the builder reads server-side once this part is actually
 * imported -- so a local generate narrows to what this app calls rather than everything the target
 * site happens to expose, then ask the site's own api to render it. The rendering itself never runs
 * here: it needs mesh-serve's own zod, which is exactly the cross-package reference this whole
 * design exists to avoid shipping to a consumer.
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'generate --site <id> [--wants file] [--out file]: render this app\'s typed client';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .requiredOption('--site <id>', 'The serve.site id to render a client for')
            .option('--wants <file>', 'Local file listing the contract keys this app calls, same format the builder reads from a repo', './mesh.wants.json')
            .option('--out <file>', 'Where to write the generated client', './generated/api.ts')
            .action(async (opts: { site: string; wants: string; out: string }) => this.execute(opts));
    }

    protected async execute({ site, wants, out }: GenerateArgs): Promise<void> {
        const contracts = await readWants(wants);
        if (contracts === undefined) {
            this.logger.info(`No ${wants} -- rendering everything "${site}" exposes.`);
        }

        const client = buildClient(this.session);
        let source: string;
        try {
            const result = await client.call('serve.api.generateClient', { siteId: site, contracts });
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
