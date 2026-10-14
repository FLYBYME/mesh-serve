import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { siteSpecSchema } from '../../deploy/spec.js';
import YAML from 'yaml';

const run = promisify(execFile);

const initInputSchema = z.object({
    site: z.string().min(1).describe('The hostname the site is served at, e.g. one-host.ca'),
    api: z.string().min(1).describe('The api hostname it calls, e.g. api.one-host.ca'),
    name: z.string().optional().describe('The file is <name>.site.yaml (default: this folder\'s name)'),
    entry: z.string().default('src/index.ts').describe('The application\'s entry file'),
});

async function git(...args: string[]): Promise<string> {
    const { stdout } = await run('git', args).catch(() => ({ stdout: '' }));

    return stdout.trim();
}

/** git@github.com:org/repo.git and https://github.com/org/repo.git as the https form the builder clones. */
function httpsUrl(remote: string): string {
    const ssh = /^git@([^:]+):(.+)$/.exec(remote);

    return ssh === null ? remote : `https://${ssh[1]}/${ssh[2]}`;
}

/** The mesh-web tag package.json pins (`github:FLYBYME/mesh-web#v0.21.10`), if it pins one. */
async function meshWebTag(): Promise<string | undefined> {
    const raw = await fs.readFile('package.json', 'utf-8').catch(() => undefined);
    if (raw === undefined) return undefined;

    const pkg: unknown = JSON.parse(raw);
    for (const field of ['dependencies', 'devDependencies']) {
        const deps: unknown = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, field) : undefined;
        const pin: unknown = typeof deps === 'object' && deps !== null ? Reflect.get(deps, '@flybyme/mesh-web') : undefined;
        if (typeof pin === 'string') return pin.split('#')[1];
    }

    return undefined;
}

/** Generated clients already in this checkout, by the api each was rendered from. */
async function generatedClients(): Promise<{ file: string; api: string }[]> {
    const dir = 'src/generated';
    const names = await fs.readdir(dir).catch((): string[] => []);
    const out: { file: string; api: string }[] = [];

    for (const name of names.filter((n) => n.endsWith('.ts'))) {
        const file = path.join(dir, name);
        const source = await fs.readFile(file, 'utf-8');
        const host = /Rendered from (\S+?)'s live exposure/.exec(source)?.[1];
        if (host !== undefined) out.push({ file, api: host });
    }

    return out;
}

/**
 * Writes `<name>.site.yaml` for this checkout: what it can read here (its remote and branch, the
 * mesh-web tag it is pinned to, the clients it was generated with), and comments saying what each
 * part is for. Never overwrites a file. Then `mesh-serve deploy` checks it.
 */
export class InitCommand extends BaseCommand {
    public readonly name = 'init';
    public readonly description = 'Write a <name>.site.yaml for this checkout, ready for mesh-serve deploy';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, initInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(initInputSchema.parse(ZodToCliMapper.parseOptions(opts, initInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof initInputSchema>): Promise<void> {
        const name = args.name ?? path.basename(process.cwd());
        const file = `${name}.site.yaml`;
        const there = await fs.stat(file).then(() => true, () => false);
        if (there) {
            this.logger.error(`${file} is already here: edit it, or remove it first.`);
            process.exitCode = 1;
            return;
        }

        const remote = httpsUrl(await git('remote', 'get-url', 'origin'));
        const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')) || 'main';
        const tag = (await meshWebTag()) ?? 'v0.21.10';
        const clients = await generatedClients();
        // The repo by its own name (surfdns-company-site), not the file's (one-host).
        const repo = path.basename(remote, '.git') || path.basename(process.cwd());
        const key = `platform/${repo}`;

        const text = `# ${name}, as mesh-serve deploys it: \`mesh-serve deploy\` (a dry run) and \`mesh-serve deploy --go\`,
# signed in as an operator of the api that will own it (\`mesh-serve login\`).

# Where the site is served, and how its page head reads.
site: ${args.site}
org: platform
title: ''
description: ''
indexable: false

# Public pages, each with its own head and sitemap entry.
pages: []

# The api the site calls. Every contract that names its own gate is served with no row. With
# \`expose\` left out, deploy leaves the api's rows as they are; a list is the whole set (rows not in
# it are removed), each with the gate it gets:
#   expose:
#     - { contract: identity.ticket.issue, gate: public }
api:
  host: ${args.api}

# The generated clients this site is typechecked against. Deploy refuses while one no longer
# matches its api: regenerate it (mesh-serve generate --host <api> --out <file>), commit, deploy.
clients:${clients.length === 0 ? ` []` : clients.map((c) => `\n  - file: ${c.file}\n    api: ${c.api}`).join('')}

repos:
  # The mesh-web kernel, at the tag package.json pins.
  - name: mesh-web
    url: https://github.com/FLYBYME/mesh-web
    ref: ${tag}
    kernel: true
  # This checkout: its parts build at the commit deploy checked.
  - name: ${repo}
    url: ${remote || 'https://github.com/<org>/<repo>'}
    ref: ${branch}
    local: true

parts:
  - repo: mesh-web
    key: ${key}-kernel
    kind: kernel
    entry: src/index.ts
    imports: '@flybyme/mesh-web'
  - repo: ${repo}
    key: ${key}
    kind: application
    entry: ${args.entry}

# A website, not a desktop of windows.
policy:
  window-manager/mode: single
`;

        // What init writes must load: a template deploy then refuses would be no start at all.
        siteSpecSchema.parse(YAML.parse(text));
        await fs.writeFile(file, text);
        this.logger.info(`Wrote ${file}. Check it, then: mesh-serve deploy`);
    }
}
