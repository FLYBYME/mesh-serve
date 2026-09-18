/**
 * Applies a site spec (console.site.json by default; pass --site for a different one) to a
 * running cluster: reconciles roles, the admin account and its organization, the site's api and
 * its exposed contracts, every repo/part, the composition, and the site itself -- adding what's
 * missing, updating what drifted, and removing exposed contracts no longer in the spec. Safe to
 * run repeatedly; nothing here throws on "already exists" the way details.ts (this file's
 * non-idempotent predecessor) does.
 *
 * Each part builds from a pinned commit sha, not a moving branch: `part.ref` if the spec sets one,
 * otherwise resolved from the owning repo's branch via `git ls-remote` right before use. Building
 * is itself cached -- if a successful artifact already exists for {partId, ref}, it's reused
 * ("linked") instead of queuing a new build, so a rerun with nothing changed does no build work at
 * all.
 *
 * Usage: npx tsx src/sync.ts [--site <path/to/site.json>] [--out <path/to/generated/api.ts>]
 * Both flags are optional; omitting either keeps this script's original console-site behavior.
 */
import {
    BrokerModule,
    JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule,
    RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IServiceBroker, IMeshApp, IServiceRegistry, z } from '@flybyme/mesh';
import type { RegisterInput, User } from './identity/contracts/user.contract.js';
import type { roleCrud } from './identity/contracts/role.contract.js';
import type { Organization } from './identity/contracts/organization.contract.js';
import type { Api } from './api/contracts/api.contract.js';
import type { Repo } from './catalog/contracts/repo.contract.js';
import type { Part } from './catalog/contracts/part.contract.js';
import { loadSite, DEFAULT_SITE_PATH, type RepoSpec, type PartSpec, type SiteSpec } from './console.site.js';

type RoleType = z.infer<typeof roleCrud.baseSchema>;

/** The default output before --out was added: the operator console's own generated client. */
const DEFAULT_OUT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mesh-operator/src/console/generated/api.ts');

/** Set once, at the top of main(), before any sync* function below (all of which read it) runs. */
let site: SiteSpec;

function parseArgs(argv: readonly string[]): { sitePath: string; outPath: string } {
    let sitePath = DEFAULT_SITE_PATH;
    let outPath = DEFAULT_OUT_PATH;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--site') sitePath = argv[++i] ?? sitePath;
        else if (argv[i] === '--out') outPath = argv[++i] ?? outPath;
    }
    return { sitePath, outPath };
}

const AdminUser: RegisterInput = {
    email: 'admin@example.com',
    password: 'password1234567',
    displayName: 'Platform Admin',
};

const Roles: RoleType[] = [
    { key: 'operator', name: 'Operator', scope: 'global', builtin: true, inherits: [], permissions: ['**'] },
    { key: 'owner', name: 'Owner', scope: 'organization', builtin: true, inherits: [], permissions: [] },
    { key: 'admin', name: 'Admin', scope: 'organization', builtin: true, inherits: [], permissions: [] },
    { key: 'member', name: 'Member', scope: 'organization', builtin: true, inherits: [], permissions: [] },
];

async function setup(): Promise<{ broker: IServiceBroker; registry: IServiceRegistry; mesh: IMeshApp }> {
    const logger = new Logger(LogLevel.WARN);
    const serializer = new JSONSerializer();

    const node = new MeshApp({ nodeID: 'sync-provider-1', logger });

    node.use(new RegistryModule({ ttl: 5000 }));
    node.use(new NetworkModule({
        bootstrapNodes: ['ws://127.0.0.1:6005'],
        transports: [new WSTransport(serializer, 0)],
    }));
    node.use(new BrokerModule());

    await node.start();

    const broker = node.getProvider<IServiceBroker>('broker');
    const registry = node.getProvider<IServiceRegistry>('registry');

    await registry.waitForNodes(2);

    return { broker, registry, mesh: node };
}

async function syncRoles(broker: IServiceBroker): Promise<void> {
    for (const role of Roles) {
        const found = await broker.call('identity.role.find_one', { query: { key: role.key, scope: role.scope } });
        if (found) continue;
        const created = await broker.call('identity.role.create', role);
        console.log('Created role', created.key);
    }
}

async function syncAdmin(broker: IServiceBroker): Promise<{ org: Organization; user: User }> {
    const foundUser = await broker.call('identity.user.find_one', { query: { email: AdminUser.email } });

    if (foundUser) {
        const org = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
        if (!org) {
            throw new Error('Admin user exists but "platform" organization does not.');
        }
        console.log('Admin user and org already exist', foundUser.id, org.id);
        return { org, user: foundUser };
    }

    const register = await broker.call('identity.user.register', AdminUser);
    let user = await broker.call('identity.user.resolve', { id: register.userId });
    if (!user) {
        throw new Error('No user found after register.');
    }

    user = await broker.call('identity.user.update', { id: user.id, provisional: false, roles: ['operator'] });

    const org = await broker.call('identity.organization.create', {
        slug: 'platform',
        name: 'Platform',
        ownerId: user.id,
    }, { meta: { tenant_id: user.id } });

    await broker.call('identity.membership.create', {
        userId: user.id,
        organizationId: org.id,
        roleKey: 'owner',
        joinedAt: new Date(),
    }, { meta: { organization_id: org.id, user_id: user.id } });

    console.log('Created admin user and org', user.id, org.id);
    return { org, user };
}

async function syncApi(broker: IServiceBroker, org: Organization): Promise<Api> {
    const meta = { tenant_id: org.id };
    const found = await broker.call('serve.api.find_one', { query: { apiHost: site.api } }, { meta });

    if (!found) {
        const created = await broker.call('serve.api.create', {
            tenantId: org.id,
            apiHost: site.api,
            description: 'Console api',
        }, { meta });
        console.log('Created api', created.id);
        return created;
    }

    console.log('Api already exists', found.id);
    return found;
}

async function syncRepos(broker: IServiceBroker, org: Organization): Promise<Repo[]> {
    const meta = { tenant_id: org.id };
    const repos: Repo[] = [];

    for (const repo of site.repos) {
        const found = await broker.call('serve.repo.find_one', { query: { tenantId: org.id, url: repo.url } }, { meta });

        if (!found) {
            const created = await broker.call('serve.repo.create', {
                tenantId: org.id, name: repo.name, url: repo.url, defaultBranch: repo.ref,
            }, { meta });
            console.log('Created repo', created.id, repo.name);
            repos.push(created);
            continue;
        }

        const updated = await broker.call('serve.repo.update', {
            id: found.id, name: repo.name, defaultBranch: repo.ref,
        }, { meta });
        console.log('Repo reconciled', updated.id, repo.name);
        repos.push(updated);
    }

    return repos;
}

async function syncParts(broker: IServiceBroker, org: Organization, repos: Repo[]): Promise<Part[]> {
    const meta = { tenant_id: org.id };
    const parts: Part[] = [];

    for (const part of site.parts) {
        const repo = repos.find((r) => r.name === part.repoName);
        if (!repo) {
            throw new Error(`No repo named "${part.repoName}" for part "${part.key}".`);
        }

        const found = await broker.call('serve.part.find_one', { query: { tenantId: org.id, key: part.key } }, { meta });

        if (!found) {
            const created = await broker.call('serve.part.create', {
                tenantId: org.id,
                repoId: repo.id,
                key: part.key,
                kind: part.kind,
                path: part.path,
                entryPoint: part.entryPoint,
                ...(part.imports !== undefined ? { imports: part.imports } : {}),
                wants: part.wants,
                description: part.description,
                ...(part.options !== undefined ? { options: part.options } : {}),
            }, { meta });
            console.log('Created part', created.id, part.key);
            parts.push(created);
            continue;
        }

        const updated = await broker.call('serve.part.update', {
            id: found.id,
            repoId: repo.id,
            kind: part.kind,
            path: part.path,
            entryPoint: part.entryPoint,
            ...(part.imports !== undefined ? { imports: part.imports } : {}),
            wants: part.wants,
            description: part.description,
            ...(part.options !== undefined ? { options: part.options } : {}),
        }, { meta });
        console.log('Part reconciled', updated.id, part.key);
        parts.push(updated);
    }

    return parts;
}

/** `part.ref` if the spec pins one; otherwise resolves the owning repo's branch to its current
 *  commit sha via `git ls-remote`, so the artifact cache below is always keyed by a real commit.
 *
 *  Async, not execFileSync: this script is itself a mesh peer node (WSTransport), and a
 *  synchronous git call against a real network remote (e.g. github.com, as opposed to the local
 *  bare mirrors) blocks the event loop for however long that takes -- long enough to miss the
 *  peer heartbeat's pong and get dropped mid-RPC, surfacing as an unrelated-looking
 *  "RPC Timeout calling serve.artifact.find_one" a few lines later, not as a git/network error. */
async function resolveRef(repo: RepoSpec, part: PartSpec): Promise<string> {
    if (part.ref !== undefined) return part.ref;

    const { stdout } = await execFileAsync('git', ['ls-remote', repo.url, repo.ref]);
    const sha = stdout.split('\n')[0]?.split('\t')[0]?.trim();
    if (!sha) {
        throw new Error(`Could not resolve ref "${repo.ref}" on ${repo.url} (part "${part.key}").`);
    }
    return sha;
}

/** Ensures each part has a successful artifact at its pinned/resolved commit -- building it if
 *  none exists yet, reusing ("linking") the existing one otherwise. Does not build the release
 *  itself; serve.composition.compose resolves each part's latest successful artifact on its own. */
async function syncArtifacts(broker: IServiceBroker, org: Organization, parts: Part[]): Promise<void> {
    const meta = { tenant_id: org.id };

    for (const part of parts) {
        const partSpec = site.parts.find((p) => p.key === part.key);
        const repoSpec = site.repos.find((r) => r.name === partSpec?.repoName);
        if (!partSpec || !repoSpec) {
            throw new Error(`No spec for built part "${part.key}".`);
        }

        const ref = await resolveRef(repoSpec, partSpec);
        const shortRef = ref.slice(0, 12);

        const existing = await broker.call('serve.artifact.find_one', {
            query: { tenantId: org.id, partId: part.id, ref, status: 'success' },
        }, { meta });

        if (existing) {
            console.log(`Artifact cached for ${part.key}@${shortRef}, linking`, existing.id);
            continue;
        }

        const build = await broker.call('serve.artifact.create', {
            tenantId: org.id, partId: part.id, ref,
        }, { meta });
        console.log(`Building ${part.key}@${shortRef}`, build.id);

        // Matches serve.queue's own dispatcher, which gives serve.artifact.build 5 minutes.
        const run = await broker.call('serve.artifact.build', { id: build.id }, { meta, timeout: 5 * 60_000 });
        if (!run.success) {
            throw new Error(`Build failed for ${part.key}@${shortRef}`);
        }

        const artifact = await broker.call('serve.artifact.resolve', { id: build.id }, { meta, timeout: 5 * 60_000 });
        if (!artifact || artifact.hash === undefined) {
            throw new Error(`No successful artifact for build ${build.id} (${part.key}@${shortRef}).`);
        }
        console.log(`Built ${part.key}@${shortRef}`, artifact.hash);
    }
}

async function syncComposition(broker: IServiceBroker, org: Organization, parts: Part[]): Promise<{ id: string }> {
    const meta = { tenant_id: org.id };

    const kernelPart = parts.find((p) => p.kind === 'kernel');
    if (!kernelPart) {
        throw new Error('No kernel part in spec.');
    }
    const themePart = parts.find((p) => p.kind === 'theme');
    const drivers = parts.filter((p) => p.kind === 'driver');
    const extensions = parts.filter((p) => p.kind === 'extension');
    const applications = parts.filter((p) => p.kind === 'application');
    const services = parts.filter((p) => p.kind === 'service');

    const fields = {
        kernelPartKey: kernelPart.id,
        theme: themePart?.id,
        drivers: drivers.map((p) => p.id),
        extensions: extensions.map((p) => p.id),
        applications: applications.map((p) => p.id),
        services: services.map((p) => p.id),
    };

    const found = await broker.call('serve.composition.find_one', { query: { tenantId: org.id, key: 'console' } }, { meta });

    if (!found) {
        const created = await broker.call('serve.composition.create', { tenantId: org.id, key: 'console', ...fields }, { meta });
        console.log('Created composition', created.id);
        return created;
    }

    const updated = await broker.call('serve.composition.update', { id: found.id, ...fields }, { meta });
    console.log('Composition reconciled', updated.id);
    return updated;
}

async function syncRelease(broker: IServiceBroker, org: Organization, compositionId: string) {
    const meta = { tenant_id: org.id };
    const release = await broker.call('serve.composition.compose', { id: compositionId }, { meta });
    console.log('Release', release.hash, `(${release.artifacts.length} artifacts)`);
    return release;
}

async function syncSite(
    broker: IServiceBroker,
    org: Organization,
    consoleApi: Api,
    releaseId: string,
    applications: Part[],
): Promise<void> {
    const meta = { tenant_id: org.id };
    const open = applications.map((p) => ({ application: p.key }));

    const found = await broker.call('serve.cdn.find_one', { query: { tenantId: org.id, host: site.cdn } }, { meta });

    const cdn = found
        ? await broker.call('serve.cdn.update', {
            id: found.id, apiId: consoleApi.id, application: 'console', open,
            title: 'Console', description: '',
        }, { meta })
        : await broker.call('serve.cdn.create', {
            tenantId: org.id, host: site.cdn, apiId: consoleApi.id, application: 'console',
            policy: {}, theme: {}, open,
            title: 'Console', description: '',
            indexable: false, maintenance: false,
        }, { meta });

    console.log(found ? 'Site reconciled' : 'Site created', cdn.id);

    const deploy = await broker.call('serve.cdn.deploy', { siteId: cdn.id, releaseId }, { meta });
    console.log('Deployed', deploy.site.host, '->', deploy.site.releaseHash?.slice(0, 12));
}

async function syncExposed(broker: IServiceBroker, org: Organization, consoleApi: Api): Promise<void> {
    const meta = { tenant_id: org.id };

    const current = await broker.call('serve.expose.find', { query: { apiId: consoleApi.id } }, { meta });
    const currentContracts = new Set(current.map((e) => e.contract));
    const desiredContracts = new Set(site.exposed);

    for (const contract of desiredContracts) {
        if (currentContracts.has(contract)) continue;
        await broker.call('serve.expose.add', { apiId: consoleApi.id, contract }, { meta });
        console.log('Exposed', contract);
    }

    for (const row of current) {
        if (desiredContracts.has(row.contract)) continue;
        await broker.call('serve.expose.remove', { apiId: consoleApi.id, contract: row.contract }, { meta });
        console.log('Unexposed', row.contract);
    }
}

/**
 * Starts every `kind: 'service'` part that isn't already running, so its contracts actually exist
 * in the live broker's registry before syncExposed tries to publish them -- building the artifact
 * (syncArtifacts, above) never runs the module, only serve.part.start's own import() +
 * registerModule does that (startService.ts). Idempotent: "already running on this node" is the
 * expected outcome on a rerun, not a failure; anything else still throws.
 */
async function syncServices(broker: IServiceBroker, org: Organization, parts: Part[]): Promise<void> {
    const meta = { tenant_id: org.id };

    for (const part of parts.filter((p) => p.kind === 'service')) {
        try {
            const started = await broker.call('serve.part.start', { id: part.id }, { meta });
            console.log('Started service', part.key, started.domain);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('already running')) {
                console.log('Service already running', part.key);
                continue;
            }
            throw err;
        }
    }
}

async function syncGeneratedClient(broker: IServiceBroker, org: Organization, consoleApi: Api, outPath: string): Promise<void> {
    const meta = { tenant_id: org.id };
    const generated = await broker.call('serve.api.generateClient', { apiId: consoleApi.id }, { meta });
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, generated.source);
    console.log('Generated client written', outPath, `(${generated.source.length} bytes)`);
}

async function main(): Promise<void> {
    const { sitePath, outPath } = parseArgs(process.argv.slice(2));
    site = loadSite(sitePath);
    console.log('Site spec', sitePath);

    const { broker, mesh } = await setup();

    try {
        await syncRoles(broker);
        const { org } = await syncAdmin(broker);

        const consoleApi = await syncApi(broker, org);
        const repos = await syncRepos(broker, org);
        const parts = await syncParts(broker, org, repos);

        await syncArtifacts(broker, org, parts);
        await syncServices(broker, org, parts);

        const composition = await syncComposition(broker, org, parts);
        const release = await syncRelease(broker, org, composition.id);

        const applications = parts.filter((p) => p.kind === 'application');
        await syncSite(broker, org, consoleApi, release.id, applications);

        await syncExposed(broker, org, consoleApi);
        await syncGeneratedClient(broker, org, consoleApi, outPath);
    } finally {
        await mesh.stop();
    }
}

main().catch((err) => {
    // Not console.error(err) directly: a MeshError crossing the remote boundary nests a full
    // stack-trace string inside its own `cause.data.stack`, and a few hops of that (RPC ->
    // rethrow -> this catch) is enough for util.inspect's pretty-printer to blow past V8's max
    // string length and crash with an unrelated "RangeError: Invalid string length" -- hiding
    // the real error behind a Node internals stack trace instead of showing it.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
