import fs from 'node:fs/promises';
import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';
import { z } from 'zod';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi, withSamePort } from '../resolveApi.js';
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

// ---------------------------------------------------------------------------- what the pipeline needs

/**
 * What `buildSite` builds, independent of where it came from -- typed the prompts into a terminal, or
 * loaded from a `--config` file. Both paths produce exactly this and hand it to the same pipeline, so
 * a config file is never a second, drifting implementation of what the interactive path already does.
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

const contractConfigSchema = z.object({
    contract: z.string().min(1),
    role: z.string().optional(),
    permission: z.string().optional(),
});

const serviceConfigSchema = z.object({
    url: z.string().min(1),
    ref: z.string().default('master'),
    name: z.string().min(1),
    path: z.string().default('.'),
    entryPoint: z.string().min(1),
});

/**
 * The `--config` file's full shape -- a complete "how to stand this app up" manifest, not just its
 * browser-side parts. `org` names an *existing* organization (init throws rather than creating one on
 * a typo -- see `org-create`); `api` is created automatically if that hostname doesn't exist yet,
 * since an api has no ownership-safety question once its organization is already verified.
 * `contracts` are exposed alongside the fixed `REQUIRED_CONTRACTS` this command always needs --
 * this is how an app's own backend contracts (`project.find`, `card.create`, ...) get exposed on its
 * api without a second, separate step. `service`, if present, is the app's backend: built and started
 * on this node the same way `repos[].parts[].kind: 'service'` would be, kept separate because it is
 * not composed into the site the way every other part is.
 */
const wizardConfigSchema = z.object({
    org: z.string().min(1),
    api: z.string().min(1),
    host: z.string().min(1),
    compositionKey: z.string().min(1).optional(),
    title: z.string().optional(),
    contracts: z.array(contractConfigSchema).default([]),
    repos: z.array(repoConfigSchema).min(1),
    service: serviceConfigSchema.optional(),
});

type WizardConfig = z.infer<typeof wizardConfigSchema>;

async function readConfig(file: string): Promise<WizardConfig> {
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
    return result.data;
}

function toWizardInput(config: WizardConfig): WizardInput {
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

const SERVICE_CONTRACT = { contract: 'serve.part.start', role: 'operator' } as const;

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
            .option('-c, --config <file>', 'Read org/api/contracts/repos/service from this JSON file instead of prompting')
            .option('--api <id>', 'The serve.api this site attaches to -- defaults to the api you\'re logged into. Ignored with --config')
            .option('--tenant <id>', 'The identity.organization everything is created in -- defaults to that api\'s own. Ignored with --config')
            .option('--org-slug <slug>', 'That organization\'s slug. Defaults to looking it up from --tenant. Ignored with --config')
            .action(async (opts: InitArgs) => this.execute(opts));
    }

    protected async execute({ api, tenant, orgSlug: orgSlugOverride, config }: InitArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const loginClient = buildClient(this.session);

        try {
            if (config !== undefined) {
                await this.runFromConfig(loginClient, config);
                return;
            }
            await this.runInteractively(loginClient, api, tenant, orgSlugOverride);
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
        }
    }

    private async runInteractively(
        loginClient: ReturnType<typeof buildClient>,
        api: string | undefined,
        tenant: string | undefined,
        orgSlugOverride: string | undefined,
    ): Promise<void> {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        // Before any awaited work with no question() in it -- see prompt.ts's warm().
        warm(rl);
        try {
            const { apiId, tenantId, apiHost } = await resolveApi(loginClient, this.session, { api, tenant });
            await this.selfHeal(loginClient, apiId, REQUIRED_CONTRACTS);

            const client = this.targetClient(apiHost);
            const orgSlug = orgSlugOverride ?? (await client.call('identity.organization.get', { id: tenantId })).slug;
            const input = await collectInteractively(rl);
            await this.buildSite(client, tenantId, apiId, orgSlug, input);
        } finally {
            rl.close();
        }
    }

    /**
     * **`org` must already exist** -- init throws rather than creating one, since a typo'd slug
     * silently creating a stray organization is a worse failure than a loud one (`org-create` is the
     * one command that makes an organization, on purpose). Membership is checked too, past whatever
     * `identity.hasRole`'s own operator bypass would otherwise allow silently: an operator *can*
     * build in any tenant, but a config naming one this account has no real relationship to is worth
     * failing loud on rather than quietly honoring.
     */
    private async runFromConfig(loginClient: ReturnType<typeof buildClient>, configFile: string): Promise<void> {
        const config = await readConfig(configFile);

        const org = await loginClient.call('identity.organization.find_one', { query: { slug: config.org } });
        if (org === undefined) {
            throw new Error(`No organization "${config.org}" -- run "org-create ${config.org} <name>" first.`);
        }
        const who = await loginClient.call('identity.whoami');
        const isMember = who.organizations.some((o) => o.organizationId === org.id);
        if (!isMember && !who.roles.includes('operator')) {
            throw new Error(`Not a member of "${config.org}" (and not an operator).`);
        }

        let api: { readonly id: string; readonly apiHost: string; readonly tenantId: string };
        try {
            api = await loginClient.call('serve.api.resolveByHost', { apiHost: config.api });
        } catch (err) {
            if (!(err instanceof MeshCallError && err.error.kind === 'not_found')) throw err;
            this.logger.info(`Creating api "${config.api}"...`);
            const loginApi = await resolveApi(loginClient, this.session, {});
            try {
                await loginClient.call('serve.expose.add', { apiId: loginApi.apiId, contract: 'serve.api.create', role: 'operator' });
            } catch (exposeErr) {
                if (!(exposeErr instanceof MeshCallError && exposeErr.error.kind === 'conflict')) throw exposeErr;
            }
            api = await loginClient.call('serve.api.create', { tenantId: org.id, apiHost: config.api });
        }
        if (api.tenantId !== org.id) {
            throw new Error(`"${config.api}" already exists but belongs to a different organization than "${config.org}".`);
        }

        // config.contracts (the service's own domain contracts, e.g. "project.find") come *after*
        // the service is built and started below -- a contract has to be registered in this node's
        // broker (which only happens once the ServiceModule that mounts it is actually running)
        // before serve.expose.add's own isPublicContract check can see it at all. Exposing it early
        // fails with "is not a public contract", indistinguishable from a genuinely-internal one,
        // for a contract that would have been perfectly fine to expose a few seconds later.
        await this.selfHeal(loginClient, api.id, [...REQUIRED_CONTRACTS, ...(config.service !== undefined ? [SERVICE_CONTRACT] : [])]);

        const client = this.targetClient(withSamePort(this.session.apiHost, api.apiHost));

        const repoIdByUrl = await this.buildSite(client, org.id, api.id, config.org, toWizardInput(config));

        if (config.service !== undefined) {
            this.logger.info('Building the backend service...');
            // Reuse the repo already created above when the service shares a URL with a frontend
            // part (flowboard's own case: its app and its server live in the same repo) -- a repo is
            // unique per (tenant, url), so creating a second row for the same URL conflicts outright.
            const repoId = repoIdByUrl.get(config.service.url)
                ?? (await client.call('serve.repo.create', { tenantId: org.id, url: config.service.url, defaultBranch: config.service.ref })).id;
            this.logger.info(`  repo ${repoId} (${config.service.url})`);
            const part = await client.call('serve.part.create', {
                tenantId: org.id, repoId, key: `${config.org}/${config.service.name}`, kind: 'service',
                path: config.service.path, entryPoint: config.service.entryPoint, wants: [],
            });
            this.logger.info(`  part ${part.id} (service)`);
            await client.call('serve.artifact.requestBuild', { partId: part.id, ref: config.service.ref });
            await this.waitForBuild(client, part);
            const started = await client.call('serve.part.start', { id: part.id });
            this.logger.info(`  started as "${started.domain}" on node "${started.nodeID}"`);
        }

        if (config.contracts.length > 0) {
            await this.selfHeal(loginClient, api.id, config.contracts);
        }
    }

    private async selfHeal(
        loginClient: ReturnType<typeof buildClient>,
        apiId: string,
        contracts: readonly { readonly contract: string; readonly role?: string; readonly permission?: string }[],
    ): Promise<void> {
        this.logger.info('Making sure this api can serve what init needs...');
        for (const { contract, role, permission } of contracts) {
            try {
                await loginClient.call('serve.expose.add', {
                    apiId, contract,
                    ...(role !== undefined ? { role } : {}),
                    ...(permission !== undefined ? { permission } : {}),
                });
                this.logger.info(`  exposed ${contract}`);
            } catch (err) {
                if (err instanceof MeshCallError && err.error.kind === 'conflict') continue;
                throw err;
            }
        }
    }

    /**
     * Every call after self-heal hits the *target* api's exposure, which may not be the api this
     * session is logged into -- `serve.expose.add` is the one call that always has to go through the
     * login host, since only the bootstrap api ever starts with it exposed automatically. See
     * `resolveApi`'s own comment.
     */
    private targetClient(apiHost: string): ReturnType<typeof buildClient> {
        return buildClient({ apiHost, credential: this.session.credential });
    }

    private async buildSite(
        client: ReturnType<typeof buildClient>,
        tenantId: string,
        apiId: string,
        orgSlug: string,
        input: WizardInput,
    ): Promise<Map<string, string>> {
        const repoIdByUrl = new Map<string, string>();
        const parts: CollectedPart[] = [];
        for (const repo of input.repos) {
            const created = await client.call('serve.repo.create', { tenantId, url: repo.url, defaultBranch: repo.ref });
            this.logger.info(`  repo ${created.id} (${repo.url})`);
            repoIdByUrl.set(repo.url, created.id);

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

        return repoIdByUrl;
    }

    private async waitForBuild(client: ReturnType<typeof buildClient>, part: { readonly id: string; readonly key: string }): Promise<void> {
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
