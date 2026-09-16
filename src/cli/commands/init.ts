import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { question, warm } from '../prompt.js';
import type { Session } from '../session.js';

interface InitArgs {
    readonly api: string;
    readonly tenant: string;
    readonly orgSlug: string;
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

/**
 * Every contract the wizard drives, self-exposed on the target api before use (role: operator,
 * matching serve.expose.add/remove's own gate) -- the same self-heal composeConsole.ts's demo script
 * does by hand for identity contracts, generalized so a fresh api needs no manual curl first. A
 * CONFLICT (already exposed) is the expected steady state after the first run, not a failure.
 */
const REQUIRED_CONTRACTS: readonly string[] = [
    'serve.repo.create', 'serve.part.create', 'serve.artifact.requestBuild', 'serve.artifact.find',
    'serve.composition.create', 'serve.composition.compose', 'serve.cdn.create', 'serve.cdn.deploy',
];

/**
 * **A wizard, not a form: `site.seed`'s single-call convenience was deleted before this session's
 * rebuild** (see `src/examples/composeConsole.ts`) because stacking repo/part/build/compose/deploy
 * behind one server-side contract made the individual steps unobservable and hard to retry from the
 * middle. This walks the same real primitives one at a time, from the terminal, printing each id as
 * it goes -- close a bad wizard run and the repos/parts already created are still there to reuse.
 */
export class InitCommand extends BaseCommand {
    public readonly name = 'init';
    public readonly description = 'init --api <id> --tenant <id> --org-slug <slug>: walk through standing up a new site, step by step';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .requiredOption('--api <id>', 'The serve.api this site attaches to')
            .requiredOption('--tenant <id>', 'The identity.organization everything is created in (an operator may name any tenant, not only the api\'s own)')
            .requiredOption('--org-slug <slug>', 'That organization\'s slug -- every part key is "<org-slug>/<name>" by construction (serve.part.create rejects any other prefix)')
            .action(async (opts: InitArgs) => this.execute(opts));
    }

    protected async execute({ api: apiId, tenant, orgSlug }: InitArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        // Before any awaited work with no question() in it -- see prompt.ts's warm().
        warm(rl);

        try {
            this.logger.info('Making sure this api can serve what init needs...');
            for (const contract of REQUIRED_CONTRACTS) {
                try {
                    await client.call('serve.expose.add', { apiId, contract, role: 'operator' });
                    this.logger.info(`  exposed ${contract}`);
                } catch (err) {
                    if (err instanceof MeshCallError && err.error.kind === 'conflict') continue;
                    throw err;
                }
            }

            const host = (await question(rl, 'Site hostname (e.g. myapp.localhost): ')).trim();
            if (host === '') throw new Error('A hostname is required.');
            const defaultKey = host.split('.')[0] ?? host;
            const compositionKey = (await question(rl, `Composition key [${defaultKey}]: `)).trim() || defaultKey;

            const parts: CollectedPart[] = [];
            let repoCount = 0;
            for (;;) {
                const url = (await question(rl, repoCount === 0
                    ? 'Repo git URL (the first must contain the kernel): '
                    : 'Another repo git URL (blank to move on): ')).trim();
                if (url === '') break;
                const defaultBranch = (await question(rl, 'Default branch/ref [master]: ')).trim() || 'master';

                const repo = await client.call('serve.repo.create', { tenantId: tenant, url, defaultBranch });
                this.logger.info(`  repo ${repo.id}`);
                repoCount++;

                for (;;) {
                    const name = (await question(rl, `  Part name from this repo, e.g. "kernel" (blank to move on): `)).trim();
                    if (name === '') break;
                    const key = `${orgSlug}/${name}`;
                    const kindRaw = (await question(rl, `  Kind [${PART_KINDS.join('/')}] (default application): `)).trim();
                    const kind = (PART_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as PartKind : 'application';
                    const path = (await question(rl, '  Path within repo [.]: ')).trim() || '.';
                    const entryPoint = (await question(rl, '  Entry point (e.g. src/index.ts): ')).trim();
                    const importsAnswer = (await question(rl, '  Import specifier other parts use to reach this one (blank = none): ')).trim();

                    const part = await client.call('serve.part.create', {
                        tenantId: tenant,
                        repoId: repo.id, key, kind, path, entryPoint, wants: [],
                        ...(importsAnswer === '' ? {} : { imports: importsAnswer }),
                    });
                    this.logger.info(`    part ${part.id} (${kind})`);

                    parts.push({ id: part.id, key: part.key, kind });

                    this.logger.info(`    requesting a build at "${defaultBranch}"...`);
                    await client.call('serve.artifact.requestBuild', { partId: part.id, ref: defaultBranch });
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
                tenantId: tenant,
                key: compositionKey,
                kernelPartKey: kernel.key,
                drivers: [],
                parts: nonKernel.map((p) => p.key),
            });
            const release = await client.call('serve.composition.compose', { id: composition.id });
            this.logger.info(`  release ${release.hash} (${release.parts.length} parts pinned)`);

            const title = (await question(rl, `Page title [${compositionKey}]: `)).trim() || compositionKey;
            const applications = parts.filter((p) => p.kind === 'application');

            this.logger.info('Creating the site...');
            const site = await client.call('serve.cdn.create', {
                tenantId: tenant,
                host, apiId,
                mcpHost: `mcp-${host}`,
                application: compositionKey,
                policy: {},
                ...(applications.length > 0 ? { open: applications.map((p) => ({ application: p.key })) } : {}),
                theme: {},
                title,
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
            rl.close();
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
