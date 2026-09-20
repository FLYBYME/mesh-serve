/**
 * Applies a site spec (console.site.yaml by default; pass --site for a different one) against a
 * cluster that is already claimed: reconciles the site's api and its exposed contracts (each with
 * the gate the spec declares), every repo/part, the composition, and the site itself -- adding
 * what's missing, updating what drifted, and removing exposed contracts no longer in the spec.
 * Safe to run repeatedly; nothing here throws on "already exists" the way this file's
 * non-idempotent predecessor (details.ts, deleted -- long superseded, never actually removed until
 * now) did.
 *
 * Each part builds from a pinned commit sha, not a moving branch: `part.ref` if the spec sets one,
 * otherwise resolved from the owning repo's branch via `git ls-remote` right before use. Building
 * is itself cached -- if a successful artifact already exists for {partId, ref}, it's reused
 * ("linked") instead of queuing a new build, so a rerun with nothing changed does no build work at
 * all.
 *
 * Usage: npx tsx src/sync.ts [--site <path/to/site.yaml>] [--out <path/to/generated/api.ts>]
 * Both flags are optional. `--site` defaults to the operator console's own spec; pass `--out` when
 * you want a client written -- there is no spec-declared fallback path any more. There used to be
 * one (`generatedClientOut`), added after a real incident (`sync --site company.site.json` with no
 * `--out` silently overwrote the console's own client; `roadmap.md` has it) where the fallback had
 * been a single hardcoded path instead. A spec-declared path was strictly better than that, but it
 * was still an absolute path on one developer's disk living inside a file that otherwise describes
 * cluster state -- the one field here that was about a workstation, not the cluster. Dropped rather
 * than kept "just in case": the site itself needs no such path to exist and be correct.
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
import type { IServiceBroker, IMeshApp, IServiceRegistry } from '@flybyme/mesh';
import type { Organization } from './identity/contracts/organization.contract.js';
import type { Api } from './api/contracts/api.contract.js';
import type { Repo } from './catalog/contracts/repo.contract.js';
import type { Part } from './catalog/contracts/part.contract.js';
import { loadSite, DEFAULT_SITE_PATH, type RepoSpec, type PartSpec, type ExposeSpec, type SiteSpec } from './console.site.js';
import { BOOTSTRAP_EXPOSED_CONTRACTS } from './api/ensureBootstrapApi.js';

/** Set once, at the top of main(), before any sync* function below (all of which read it) runs. */
let site: SiteSpec;
let force: boolean = false;

/**
 * `outPath` defaults to `undefined`, not some hardcoded path -- it used to default to the operator
 * console's own generated client (`mesh-operator/src/console/generated/api.ts`), which meant running
 * this CLI against *any other* site with no `--out` silently overwrote the console's client with one
 * generated from that other site's exposure. No fallback of any kind now, spec-declared or
 * hardcoded: `syncSpec` skips client generation outright when `outPath` is absent. See the file
 * header for the full history (`roadmap.md` has the original incident).
 */
function parseArgs(argv: readonly string[]): { sitePath: string; outPath: string | undefined; force: boolean } {
    let sitePath = DEFAULT_SITE_PATH;
    let outPath: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--site') sitePath = argv[++i] ?? sitePath;
        else if (argv[i] === '--out') outPath = argv[++i] ?? outPath;
        else if (argv[i] === '--force') force = true;
    }
    return { sitePath, outPath, force };
}

async function setup(bootstrapNode = 'ws://127.0.0.1:6005', sharedKey?: string): Promise<{ broker: IServiceBroker; registry: IServiceRegistry; mesh: IMeshApp }> {
    const logger = new Logger(LogLevel.WARN);
    const serializer = new JSONSerializer();

    // Per process -- see cli/commands/bootstrap.ts's note. sync-all.ts runs this in a loop, and a
    // fixed id turned any overlap into a node-count timeout.
    const node = new MeshApp({ nodeID: `sync-provider-${String(process.pid)}`, logger });

    node.use(new RegistryModule());
    node.use(new NetworkModule({
        bootstrapNodes: [bootstrapNode],
        transports: [new WSTransport(serializer, 0, undefined, { authKey: sharedKey })],
    }));
    node.use(new BrokerModule());

    await node.start();

    const broker = node.getProvider<IServiceBroker>('broker');
    const registry = node.getProvider<IServiceRegistry>('registry');

    await registry.waitForNodes(2);

    return { broker, registry, mesh: node };
}

/**
 * The organization everything here belongs to -- found, never created.
 *
 * This used to be `syncAdmin`, which created an operator and the "platform" organization if it
 * could not find them, hunting for a hardcoded `operator@node.invalid` because that is what
 * `identity.service.ts`'s first-boot `onStart` used to seed. Neither of those exists any more:
 * seeding at load time was removed (loading is per node, so five nodes booting meant five racing
 * seed loops), and `bootstrap` now asks a real person for a real email. So the lookup could never
 * match on a real cluster, and the fallback path would `register` a second account and then
 * collide on the "platform" slug bootstrap had already taken -- leaving a stray, orphaned account
 * behind. That is the same failure its own comment described being fixed once before; making
 * bootstrap interactive quietly un-fixed it.
 *
 * Claiming a cluster is a decision a person makes once, and `bootstrap` is where they make it.
 * Refusing here, with the command to run, is the honest version of what this was pretending to do.
 */
async function requireClaimedCluster(broker: IServiceBroker): Promise<Organization> {
    const org = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
    if (org === undefined) {
        throw new Error('This cluster has not been claimed -- no "platform" organization. Run `mesh-serve bootstrap` first.');
    }
    return org;
}

async function syncApi(broker: IServiceBroker, org: Organization): Promise<Api> {
    const meta = { tenant_id: org.id };
    const found = await broker.call('serve.api.find_one', { query: { apiHost: site.api.host } }, { meta });

    if (!found) {
        const created = await broker.call('serve.api.create', {
            tenantId: org.id,
            apiHost: site.api.host,
            description: `Api for ${site.site}`,
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
        const repo = repos.find((r) => r.name === part.repo);
        if (!repo) {
            throw new Error(`No repo named "${part.repo}" for part "${part.key}".`);
        }

        const found = await broker.call('serve.part.find_one', { query: { tenantId: org.id, key: part.key } }, { meta });

        // No `wants` here in either branch: the spec no longer carries it. It used to
        // (partSpecSchema had its own `wants: []`, always empty, always overwritten), but the row's
        // real value is set by build.ts from the part's own mesh.wants.json -- a hand-written copy
        // of that in the spec could only ever be stale or redundant, never authoritative. Omitting
        // the field leaves the schema's own default (`[]`) on create and leaves the existing value
        // alone on update, so a build's own write is never clobbered by a reconcile that runs after
        // it.
        if (!found) {
            const created = await broker.call('serve.part.create', {
                tenantId: org.id,
                repoId: repo.id,
                key: part.key,
                kind: part.kind,
                path: part.path,
                entryPoint: part.entry,
                ...(part.imports !== undefined ? { imports: part.imports } : {}),
                ...(part.description !== undefined ? { description: part.description } : {}),
                ...(part.options !== undefined ? { options: part.options } : {}),
                ...(part.desired !== undefined ? { desired: part.desired } : {}),
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
            entryPoint: part.entry,
            ...(part.imports !== undefined ? { imports: part.imports } : {}),
            ...(part.description !== undefined ? { description: part.description } : {}),
            ...(part.options !== undefined ? { options: part.options } : {}),
            ...(part.desired !== undefined ? { desired: part.desired } : {}),
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
async function syncArtifacts(broker: IServiceBroker, org: Organization, parts: Part[], force: boolean): Promise<void> {
    const meta = { tenant_id: org.id };

    for (const part of parts) {
        const partSpec = site.parts.find((p) => p.key === part.key);
        const repoSpec = site.repos.find((r) => r.name === partSpec?.repo);
        if (!partSpec || !repoSpec) {
            throw new Error(`No spec for built part "${part.key}".`);
        }

        const ref = await resolveRef(repoSpec, partSpec);
        const shortRef = ref.slice(0, 12);

        const existing = await broker.call('serve.artifact.find_one', {
            query: { tenantId: org.id, partId: part.id, ref, status: 'success' },
        }, { meta });

        if (existing && !force) {
            console.log(`Artifact cached for ${part.key}@${shortRef}, linking`, existing.id);
            continue;
        }

        // requestBuild, not a raw artifact.create: `serve.artifact`'s own contract declares
        // create/update/delete internal precisely so every build goes through the validated path
        // (resolving the part, checking driver kinds, defaulting status). Writing the row directly
        // skipped all of it -- which worked only because this file talks to the mesh rather than
        // through the api, where it would have been refused. The api was right and this was wrong.
        const build = await broker.call('serve.artifact.requestBuild', {
            partId: part.id, ref,
        }, { meta });
        console.log(`Building ${part.key}@${shortRef}`, build.id);

        // Not a direct call to serve.artifact.build either, for the same reason: it is
        // deliberately internal (no `visibility: 'public'`), reached only through serve.queue's own
        // dispatcher, never by name. requestBuild only queues the row as 'pending' -- watchRelease
        // is what sweeps pending artifacts and hands each to the queue, and it already runs on its
        // own 60s interval with no action needed; calling it here just avoids waiting up to a full
        // interval for a build sync itself just queued. Same pattern composeOnCluster.ts already
        // uses. What follows is a plain poll of `get`, the same shape an operator watching this
        // build's progress through the api would see -- there is no privileged shortcut here that a
        // real caller couldn't also take.
        await broker.call('serve.artifact.watchRelease', {}, { meta });

        const deadline = Date.now() + 5 * 60_000;
        let artifact = await broker.call('serve.artifact.get', { id: build.id }, { meta });
        while (artifact !== undefined && (artifact.status === 'pending' || artifact.status === 'running')) {
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for ${part.key}@${shortRef} to build (still "${artifact.status}").`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
            artifact = await broker.call('serve.artifact.get', { id: build.id }, { meta });
        }

        if (artifact === undefined || artifact.status !== 'success' || artifact.hash === undefined) {
            throw new Error(`Build failed for ${part.key}@${shortRef}: ${artifact?.error ?? 'no successful artifact'}`);
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

    // Keyed by the site's own hostname, not a fixed 'console' -- one process now hosts more than
    // one site (this file's whole reason to take a --site argument), and a fixed key meant every
    // site after the first silently overwrote the console's own composition instead of getting its
    // own. serve.cdn.host is already the platform's unique handle for "which site"; reusing it here
    // keeps that the one identifier a site has, rather than inventing a second.
    const found = await broker.call('serve.composition.find_one', { query: { tenantId: org.id, key: site.site } }, { meta });

    if (!found) {
        const created = await broker.call('serve.composition.create', { tenantId: org.id, key: site.site, ...fields }, { meta });
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

    // The first application-kind part in declaration order is what the site actually opens; the
    // rest are bundled and available (mesh-web's own `open` list, above) but not launched by
    // default -- e.g. dns.site.yaml composes both platform/domains (primary) and
    // platform/nameserver (a secondary telemetry app, reachable but not the landing page).
    const primary = applications[0];
    if (primary === undefined) {
        throw new Error('No kind: "application" part in spec -- a site needs one to open.');
    }

    const found = await broker.call('serve.cdn.find_one', { query: { tenantId: org.id, host: site.site } }, { meta });
    // `?? {}` matches the create branch's own default below -- a site spec declaring no `policy`
    // means "nothing frozen," the same as every site before this field existed, not "leave whatever
    // was there" (which is what leaving `policy` out of the update call entirely used to silently do).
    const policy = site.policy ?? {};
    // Empty, not a hardcoded name: serve.cdn's own schema already falls back title to `application`
    // when title is empty, so this is a real default rather than a second place a site's display
    // name could be declared and drift from the first.
    const title = '';

    const cdn = found
        ? await broker.call('serve.cdn.update', {
            id: found.id, apiId: consoleApi.id, application: primary.key, open, policy,
            title, description: '',
        }, { meta })
        : await broker.call('serve.cdn.create', {
            tenantId: org.id, host: site.site, apiId: consoleApi.id, application: primary.key,
            policy, theme: {}, open,
            title, description: '',
            indexable: false, maintenance: false,
        }, { meta });

    console.log(found ? 'Site reconciled' : 'Site created', cdn.id);

    const deploy = await broker.call('serve.cdn.deploy', { siteId: cdn.id, releaseId }, { meta });
    console.log('Deployed', deploy.site.host, '->', deploy.site.releaseHash?.slice(0, 12));
}

/** A row's gate, in the same shape `ExposeSpec.gate` declares it, so the two can be compared. */
function gateOfRow(row: { role?: string; permission?: string }): ExposeSpec['gate'] {
    if (row.role !== undefined) return { role: row.role };
    if (row.permission !== undefined) return { permission: row.permission };
    return 'public';
}

function sameGate(a: ExposeSpec['gate'], b: ExposeSpec['gate']): boolean {
    if (a === 'public' || b === 'public') return a === b;
    if ('role' in a && 'role' in b) return a.role === b.role;
    if ('permission' in a && 'permission' in b) return a.permission === b.permission;
    return false;
}

/**
 * A contract bootstrap itself gates (`BOOTSTRAP_EXPOSED_CONTRACTS`) is never removed by a site sync,
 * whatever the spec says or leaves unsaid. sync's `remove` pass below is "anything current but not
 * desired" -- correct for an api this file owns end to end, and dangerous for one it does not:
 * pointing a site spec's `api.host` at the bootstrap api (as an operator debugging `--parts api,cdn`
 * once did) would otherwise silently strip every management row this session added, including
 * `serve.expose.add` -- the one call that could put them back.
 */
const BOOTSTRAP_OWNED = new Set(BOOTSTRAP_EXPOSED_CONTRACTS.map((c) => c.contract));

async function syncExposed(broker: IServiceBroker, org: Organization, consoleApi: Api): Promise<void> {
    const meta = { tenant_id: org.id };

    const current = await broker.call('serve.expose.find', { query: { apiId: consoleApi.id } }, { meta });
    const currentByContract = new Map(current.map((row) => [row.contract, row]));
    const desired = new Map(site.api.expose.map((spec) => [spec.contract, spec]));

    for (const [contract, spec] of desired) {
        const existing = currentByContract.get(contract);

        if (existing === undefined) {
            await broker.call('serve.expose.add', {
                apiId: consoleApi.id, contract,
                ...(spec.gate !== 'public' ? spec.gate : {}),
            }, { meta });
            console.log('Exposed', contract, gateLabel(spec.gate));
            continue;
        }

        if (!sameGate(gateOfRow(existing), spec.gate)) {
            // No update on this collection (`add`'s own 409 is what enforces "one row per
            // contract"), so changing a gate is remove-then-add, same as a person would do it by
            // hand through expose.remove/expose.add.
            await broker.call('serve.expose.remove', { apiId: consoleApi.id, contract }, { meta });
            await broker.call('serve.expose.add', {
                apiId: consoleApi.id, contract,
                ...(spec.gate !== 'public' ? spec.gate : {}),
            }, { meta });
            console.log('Regated', contract, gateLabel(spec.gate));
        }
    }

    for (const row of current) {
        if (desired.has(row.contract)) continue;
        if (BOOTSTRAP_OWNED.has(row.contract)) {
            console.log('Leaving', row.contract, '-- bootstrap-owned, not this spec\'s to remove');
            continue;
        }
        await broker.call('serve.expose.remove', { apiId: consoleApi.id, contract: row.contract }, { meta });
        console.log('Unexposed', row.contract);
    }
}

function gateLabel(gate: ExposeSpec['gate']): string {
    if (gate === 'public') return '(public)';
    if ('role' in gate) return `(role: ${gate.role})`;
    return `(permission: ${gate.permission})`;
}

/**
 * Starts every `kind: 'service'` part that isn't already running, so its contracts actually exist
 * in the live broker's registry before syncExposed tries to publish them -- building the artifact
 * (syncArtifacts, above) never runs the module, only serve.part.start's own require() +
 * loadDomain does that (startService.ts). Idempotent: "already running on this node" is the
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

/**
 * Applies one site spec end to end -- everything main() used to do inline. Exported so a caller
 * that knows about more than one site (sync-all.ts) can run this in a loop instead of reimplementing
 * orchestration a second time; sync.ts's own CLI (main(), below) is just the single-site case of
 * this with argv-parsed arguments.
 *
 * `outPath` is optional: absent, client generation is skipped rather than guessing a path. See the
 * file header for why there is no longer a spec-declared fallback to guess from.
 */
export async function syncSpec(
    sitePath: string,
    outPath?: string,
    force = false,
    connect?: { bootstrapNode?: string; sharedKey?: string },
): Promise<void> {
    site = loadSite(sitePath);
    console.log('Site spec', sitePath);

    const { broker, mesh } = await setup(connect?.bootstrapNode, connect?.sharedKey);

    try {
        // No role seeding here either: `bootstrap` calls `identity.role.ensureBuiltins` as part of
        // claiming, before anything can be granted `operator`. Doing it again from here was a
        // second owner of the same shared cluster state, differing only in which one ran first.
        const org = await requireClaimedCluster(broker);

        const consoleApi = await syncApi(broker, org);
        const repos = await syncRepos(broker, org);
        const parts = await syncParts(broker, org, repos);

        await syncArtifacts(broker, org, parts, force);
        await syncServices(broker, org, parts);

        const composition = await syncComposition(broker, org, parts);
        const release = await syncRelease(broker, org, composition.id);

        const applications = parts.filter((p) => p.kind === 'application');
        await syncSite(broker, org, consoleApi, release.id, applications);

        await syncExposed(broker, org, consoleApi);

        if (outPath !== undefined) {
            await syncGeneratedClient(broker, org, consoleApi, outPath);
        } else {
            console.log('No --out given; skipping client generation.');
        }
    } finally {
        await mesh.stop();
    }
}

async function main(): Promise<void> {
    const { sitePath, outPath, force } = parseArgs(process.argv.slice(2));
    await syncSpec(sitePath, outPath, force);
}

// Only when run directly (`npx tsx src/sync.ts`), not when sync-all.ts imports syncSpec from this
// module -- an unconditional call here ran this file's own CLI a second time, on import, for every
// site sync-all.ts was trying to sync one at a time.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        // Not console.error(err) directly: a MeshError crossing the remote boundary nests a full
        // stack-trace string inside its own `cause.data.stack`, and a few hops of that (RPC ->
        // rethrow -> this catch) is enough for util.inspect's pretty-printer to blow past V8's max
        // string length and crash with an unrelated "RangeError: Invalid string length" -- hiding
        // the real error behind a Node internals stack trace instead of showing it.
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    });
}
