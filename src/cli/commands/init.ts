import fs from 'node:fs/promises';
import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';
import { z } from 'zod';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi } from '../resolveApi.js';
import { question, warm } from '../prompt.js';
import type { Session } from '../session.js';

interface InitArgs {
    readonly api?: string;
    readonly tenant?: string;
    readonly orgSlug?: string;
    readonly config?: string;
}

const PART_KINDS = ['kernel', 'application', 'extension', 'driver', 'theme'] as const;
type PartKind = typeof PART_KINDS[number];

interface CollectedPart {
    readonly id: string;
    readonly key: string;
    readonly kind: PartKind;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------- what the wizard needs

/**
 * What `init` builds, independent of where it came from -- typed the prompts into a terminal, or
 * loaded from a `--config` file. Both paths produce exactly this and hand it to `runPipeline`, so a
 * config file is never a second, drifting implementation of what the interactive path already does.
 */
interface WizardInput {
    readonly host: string;
    readonly compositionKey: string;
    readonly title: string;
    readonly repos: readonly {
        readonly url: string;
        readonly ref: string;
        readonly parts: readonly {
            readonly name: string;
            readonly kind: PartKind;
            readonly path: string;
            readonly entryPoint: string;
            readonly imports?: string;
        }[];
    }[];
}

const partConfigSchema = z.object({
    name: z.string().min(1),
    kind: z.enum(PART_KINDS).default('application'),
    path: z.string().default('.'),
    entryPoint: z.string().min(1),
    imports: z.string().optional(),
});

const repoConfigSchema = z.object({
    url: z.string().min(1),
    ref: z.string().default('master'),
    parts: z.array(partConfigSchema).min(1),
});

/**
 * The `--config` file's shape. `host` is the only thing every run must decide on the spot rather than
 * check into a file (it's per-deployment, not per-app) -- everything else here is exactly what a
 * checked-in "how to stand this app up" manifest should hold: which repos, which refs, which parts.
 */
const wizardConfigSchema = z.object({
    host: z.string().min(1),
    compositionKey: z.string().min(1).optional(),
    title: z.string().optional(),
    repos: z.array(repoConfigSchema).min(1),
});

async function loadConfig(file: string): Promise<WizardInput> {
    const raw = await fs.readFile(file, 'utf-8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${file} is not valid JSON.`);
    }
    const result = wizardConfigSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(`${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const config = result.data;
    const defaultKey = config.host.split('.')[0] ?? config.host;
    return {
        host: config.host,
        compositionKey: config.compositionKey ?? defaultKey,
        title: config.title ?? config.compositionKey ?? defaultKey,
        repos: config.repos,
    };
}

async function collectInteractively(rl: readline.Interface): Promise<WizardInput> {
    const host = (await question(rl, 'Site hostname (e.g. myapp.localhost): ')).trim();
    if (host === '') throw new Error('A hostname is required.');
    const defaultKey = host.split('.')[0] ?? host;
    const compositionKey = (await question(rl, `Composition key [${defaultKey}]: `)).trim() || defaultKey;
    const title = (await question(rl, `Page title [${compositionKey}]: `)).trim() || compositionKey;

    const repos: WizardInput['repos'][number][] = [];
    let repoCount = 0;
    for (;;) {
        const url = (await question(rl, repoCount === 0
            ? 'Repo git URL (the first must contain the kernel): '
            : 'Another repo git URL (blank to move on): ')).trim();
        if (url === '') break;
        const ref = (await question(rl, 'Default branch/ref [master]: ')).trim() || 'master';

        const parts: WizardInput['repos'][number]['parts'][number][] = [];
        for (;;) {
            const name = (await question(rl, '  Part name from this repo, e.g. "kernel" (blank to move on): ')).trim();
            if (name === '') break;
            const kindRaw = (await question(rl, `  Kind [${PART_KINDS.join('/')}] (default application): `)).trim();
            const kind = (PART_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as PartKind : 'application';
            const path = (await question(rl, '  Path within repo [.]: ')).trim() || '.';
            const entryPoint = (await question(rl, '  Entry point (e.g. src/index.ts): ')).trim();
            const importsAnswer = (await question(rl, '  Import specifier other parts use to reach this one (blank = none): ')).trim();
            parts.push({ name, kind, path, entryPoint, ...(importsAnswer === '' ? {} : { imports: importsAnswer }) });
        }
        repos.push({ url, ref, parts });
        repoCount++;
    }

    return { host, compositionKey, title, repos };
}

// ---------------------------------------------------------------------------- the pipeline itself

/**
 * Every contract the wizard drives, self-exposed on the target api before use (role: operator,
 * matching serve.expose.add/remove's own gate) -- the same self-heal composeConsole.ts's demo script
 * does by hand for identity contracts, generalized so a fresh api needs no manual curl first. A
 * CONFLICT (already exposed) is the expected steady state after the first run, not a failure.
 */
const REQUIRED_CONTRACTS: readonly { contract: string; role?: string }[] = [
    { contract: 'serve.repo.create', role: 'operator' },
    { contract: 'serve.part.create', role: 'operator' },
    { contract: 'serve.artifact.requestBuild', role: 'operator' },
    { contract: 'serve.artifact.find', role: 'operator' },
    { contract: 'serve.composition.create', role: 'operator' },
    { contract: 'serve.composition.compose', role: 'operator' },
    { contract: 'serve.cdn.create', role: 'operator' },
    { contract: 'serve.cdn.deploy', role: 'operator' },
    // No role: only read when --org-slug is omitted, to construct a valid part key -- see
    // BOOTSTRAP_EXPOSED_CONTRACTS's own comment on why this one is public.
    { contract: 'identity.organization.get' },
];

/**
 * **A wizard, not a form: `site.seed`'s single-call convenience was deleted before this session's
 * rebuild** (see `src/examples/composeConsole.ts`) because stacking repo/part/build/compose/deploy
 * behind one server-side contract made the individual steps unobservable and hard to retry from the
 * middle. This walks the same real primitives one at a time -- from the terminal, or from a `--config`
 * file for a run worth checking in and repeating -- printing each id as it goes: close a bad run and
 * the repos/parts already created are still there to reuse.
 */
export class InitCommand extends BaseCommand {
    public readonly name = 'init';
    public readonly description = 'init [-c config.json] [--api <id>] [--tenant <id>] [--org-slug <slug>]: stand up a new site';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .option('-c, --config <file>', 'Read host/repos/parts from this JSON file instead of prompting')
            .option('--api <id>', 'The serve.api this site attaches to -- defaults to the api you\'re logged into')
            .option('--tenant <id>', 'The identity.organization everything is created in -- defaults to that api\'s own (an operator may name a different one)')
            .option('--org-slug <slug>', 'That organization\'s slug -- every part key is "<org-slug>/<name>" by construction. Defaults to looking it up from --tenant')
            .action(async (opts: InitArgs) => this.execute(opts));
    }

    protected async execute({ api, tenant, orgSlug: orgSlugOverride, config }: InitArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);
        const rl = config === undefined ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
        // Before any awaited work with no question() in it -- see prompt.ts's warm().
        if (rl !== undefined) warm(rl);

        try {
            const { apiId, tenantId } = await resolveApi(client, this.session, { api, tenant });
            this.logger.info('Making sure this api can serve what init needs...');
            for (const { contract, role } of REQUIRED_CONTRACTS) {
                try {
                    await client.call('serve.expose.add', { apiId, contract, ...(role !== undefined ? { role } : {}) });
                    this.logger.info(`  exposed ${contract}`);
                } catch (err) {
                    if (err instanceof MeshCallError && err.error.kind === 'conflict') continue;
                    throw err;
                }
            }

            const orgSlug = orgSlugOverride ?? (await client.call('identity.organization.get', { id: tenantId })).slug;
            const input = config !== undefined ? await loadConfig(config) : await collectInteractively(rl!);

            const parts: CollectedPart[] = [];
            for (const repo of input.repos) {
                const created = await client.call('serve.repo.create', { tenantId, url: repo.url, defaultBranch: repo.ref });
                this.logger.info(`  repo ${created.id} (${repo.url})`);

                for (const p of repo.parts) {
                    const key = `${orgSlug}/${p.name}`;
                    const part = await client.call('serve.part.create', {
                        tenantId,
                        repoId: created.id, key, kind: p.kind, path: p.path, entryPoint: p.entryPoint, wants: [],
                        ...(p.imports !== undefined ? { imports: p.imports } : {}),
                    });
                    this.logger.info(`    part ${part.id} (${p.kind})`);

                    parts.push({ id: part.id, key: part.key, kind: p.kind });

                    this.logger.info(`    requesting a build at "${repo.ref}"...`);
                    await client.call('serve.artifact.requestBuild', { partId: part.id, ref: repo.ref });
                }
            }

            if (parts.length === 0) throw new Error('Nothing was added. Init needs at least one part.');

            const kernel = parts.find((p) => p.kind === 'kernel');
            if (kernel === undefined) throw new Error('No kind: kernel part was added -- a composition needs exactly one.');
            const nonKernel = parts.filter((p) => p.kind !== 'kernel');

            this.logger.info('Waiting for every build to finish (the catalog polls every 60s, this can take a minute)...');
            for (const part of parts) {
                await this.waitForBuild(client, part);
            }

            this.logger.info('Composing...');
            const composition = await client.call('serve.composition.create', {
                tenantId,
                key: input.compositionKey,
                kernelPartKey: kernel.key,
                drivers: [],
                parts: nonKernel.map((p) => p.key),
            });
            const release = await client.call('serve.composition.compose', { id: composition.id });
            this.logger.info(`  release ${release.hash} (${release.parts.length} parts pinned)`);

            const applications = parts.filter((p) => p.kind === 'application');

            this.logger.info('Creating the site...');
            const site = await client.call('serve.cdn.create', {
                tenantId,
                host: input.host, apiId,
                mcpHost: `mcp-${input.host}`,
                application: input.compositionKey,
                policy: {},
                ...(applications.length > 0 ? { open: applications.map((p) => ({ application: p.key })) } : {}),
                theme: {},
                title: input.title,
                description: '',
                indexable: false,
                maintenance: false,
            });

            const deployed = await client.call('serve.cdn.deploy', { siteId: site.id, releaseHash: release.hash });
            this.logger.info(`\nDone. ${deployed.site.host} is deployed and pointed at ${deployed.site.releaseHash}.`);
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            if (err instanceof Error) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        } finally {
            rl?.close();
        }
    }

    private async waitForBuild(client: ReturnType<typeof buildClient>, part: CollectedPart): Promise<void> {
        for (let i = 0; i < 90; i++) {
            const artifacts = await client.call('serve.artifact.find', { query: { partId: part.id } });
            const latest = artifacts[artifacts.length - 1];
            if (latest?.status === 'success') {
                this.logger.info(`  ${part.key}: built (${latest.hash})`);
                return;
            }
            if (latest?.status === 'failed') {
                throw new Error(`${part.key} failed to build: ${latest.error ?? 'unknown error'}`);
            }
            await sleep(2000);
        }
        throw new Error(`${part.key} timed out waiting for a build`);
    }
}
