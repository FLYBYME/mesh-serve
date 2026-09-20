/**
 * Applies a site spec (console.site.yaml by default; pass --site for a different one) against a
 * cluster that is already claimed: reconciles the site's api and its exposed contracts (each with
 * the gate the spec declares), every repo/part, the composition, and the site itself -- adding
 * what's missing, updating what drifted, and removing exposed contracts no longer in the spec.
 * Safe to run repeatedly; nothing here throws on "already exists" the way this file's
 * non-idempotent predecessor (details.ts, deleted -- long superseded, never actually removed until
 * now) did.
 *
 * Entirely an api client -- every call here goes through `callApi`, the same as a discovered CLI
 * command or a browser would, using whichever api and ticket `mesh-serve login`/`switch` last left
 * in `~/.mesh-serve/session.json`. This used to connect to the mesh directly, the same trust
 * `bootstrap` reasonably assumes -- but that reasoning does not actually hold here: `bootstrap`'s
 * whole job is to create the gate that api access goes through, so it has nothing to authenticate
 * against yet. `sync` runs long *after* that, against a cluster with a real api already up, doing
 * nothing an operator with the right role could not already do one call at a time through it. Going
 * around the api was the same shortcut this file's own history keeps finding and removing --
 * `syncAdmin`, a raw `serve.artifact.create`, a raw `serve.artifact.build` -- just at the level of
 * the whole connection this time instead of one call.
 *
 * Each part builds from a pinned commit sha, not a moving branch: `part.ref` if the spec sets one,
 * otherwise resolved from the owning repo's branch via `git ls-remote` right before use. Building
 * is itself cached -- if a successful artifact already exists for {partId, ref}, it's reused
 * ("linked") instead of queuing a new build, so a rerun with nothing changed does no build work at
 * all.
 *
 * Usage: npx tsx src/sync.ts [--site <path/to/site.yaml>] [--out <path/to/generated/api.ts>]
 * Sign in first (`mesh-serve login`) and point at the api that will own this site's rows
 * (`mesh-serve switch`) -- this reads that session, the same one the CLI's own `sync` command
 * reads, rather than taking a separate login of its own. `--site` defaults to the operator
 * console's own spec; pass `--out` when you want a client written -- there is no spec-declared
 * fallback path any more. There used to be one (`generatedClientOut`), added after a real incident
 * (`sync --site company.site.json` with no `--out` silently overwrote the console's own client;
 * `roadmap.md` has it) where the fallback had been a single hardcoded path instead. A spec-declared
 * path was strictly better than that, but it was still an absolute path on one developer's disk
 * living inside a file that otherwise describes cluster state -- the one field here that was about
 * a workstation, not the cluster. Dropped rather than kept "just in case": the site itself needs no
 * such path to exist and be correct.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Api } from './api/contracts/api.contract.js';
import type { Repo } from './catalog/contracts/repo.contract.js';
import type { Part } from './catalog/contracts/part.contract.js';
import { loadSite, DEFAULT_SITE_PATH, type RepoSpec, type PartSpec, type ExposeSpec, type SiteSpec } from './console.site.js';
import { BOOTSTRAP_EXPOSED_CONTRACTS } from './api/ensureBootstrapApi.js';
import { ApiError, callApi, describeApi } from './cli/core/apiClient.js';
import { isLive, readSession } from './cli/core/session.js';
import type { ExposureDescriptor } from './api/methods/descriptor.js';

/** Set once, at the top of syncSpec, before any sync* function below (all of which read it) runs. */
let site: SiteSpec;

/** What every sync* function below actually needs to make a call: the api and the ticket, plus its
 *  current surface so a call can be matched to the real method/path/gate it was exposed under. */
interface Client {
    readonly apiUrl: string;
    readonly token: string;
    readonly descriptor: ExposureDescriptor;
}

async function connect(): Promise<Client> {
    const session = await readSession();
    if (session.apiUrl === undefined) {
        throw new Error('Not pointed at an api. Run `mesh-serve switch <url>` first.');
    }
    if (!isLive(session)) {
        throw new Error('No live ticket. Run `mesh-serve login` first.');
    }
    // Fresh, not the CLI's cached descriptor -- sync is exactly the tool that changes what an api
    // exposes (syncExposed, below), and a stale surface from before a previous run's own changes
    // would make this file fail to find calls it just added.
    const descriptor = await describeApi(session.apiUrl);
    return { apiUrl: session.apiUrl, token: session.token!, descriptor };
}

/**
 * Every `broker.call(key, params, { meta })` this file used to make, replaced with this: find the
 * call `key` names in the api's own current surface, and make it exactly the way a discovered CLI
 * command or a browser would. There is no `meta` parameter any more -- the tenant a create/update
 * writes into comes from `tenantId` in the request body (an operator's explicit tenantId is
 * honored; see api/gateway.ts's own checkGate), and a read's scope comes from the caller's own
 * resolved membership, the same as it would for any other caller.
 */
async function call<T = unknown>(client: Client, key: string, params: Record<string, unknown>): Promise<T> {
    const found = client.descriptor.calls.find((c) => c.key === key);
    if (found === undefined) {
        throw new Error(`"${key}" is not exposed on ${client.descriptor.host} -- add it to this site's own api.expose, or the bootstrap api's, before syncing.`);
    }
    return await callApi(client.apiUrl, found, params, client.token) as T;
}

/**
 * `outPath` defaults to `undefined`, not some hardcoded path -- see the file header for the
 * history. No fallback of any kind now: `syncSpec` skips client generation outright when `outPath`
 * is absent.
 */
function parseArgs(argv: readonly string[]): { sitePath: string; outPath: string | undefined; force: boolean } {
    let sitePath = DEFAULT_SITE_PATH;
    let outPath: string | undefined;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--site') sitePath = argv[++i] ?? sitePath;
        else if (argv[i] === '--out') outPath = argv[++i] ?? outPath;
        else if (argv[i] === '--force') force = true;
    }
    return { sitePath, outPath, force };
}

/** The organization everything here belongs to -- resolved from the caller's own identity, not
 *  looked up by a fixed slug. Whoever is signed in owns this: `identity.whoami` is what `login`
 *  itself already trusts to say who that is. */
async function resolveOrg(client: Client): Promise<{ id: string }> {
    const who = await call<{ organizations: { organizationId: string }[] }>(client, 'identity.whoami', {});
    const org = who.organizations[0];
    if (org === undefined) {
        throw new Error('Signed-in account belongs to no organization -- nothing for sync to act as.');
    }
    return { id: org.organizationId };
}

async function syncApi(client: Client, org: { id: string }): Promise<Api> {
    const found = await call<Api | undefined>(client, 'serve.api.find_one', { query: { apiHost: site.api.host } });

    if (found === undefined) {
        const created = await call<Api>(client, 'serve.api.create', {
            tenantId: org.id,
            apiHost: site.api.host,
            description: `Api for ${site.site}`,
        });
        console.log('Created api', created.id);
        return created;
    }

    console.log('Api already exists', found.id);
    return found;
}

async function syncRepos(client: Client, org: { id: string }): Promise<Repo[]> {
    const repos: Repo[] = [];

    for (const repo of site.repos) {
        const found = await call<Repo | undefined>(client, 'serve.repo.find_one', { query: { tenantId: org.id, url: repo.url } });

        if (found === undefined) {
            const created = await call<Repo>(client, 'serve.repo.create', {
                tenantId: org.id, name: repo.name, url: repo.url, defaultBranch: repo.ref,
            });
            console.log('Created repo', created.id, repo.name);
            repos.push(created);
            continue;
        }

        const updated = await call<Repo>(client, 'serve.repo.update', {
            id: found.id, name: repo.name, defaultBranch: repo.ref,
        });
        console.log('Repo reconciled', updated.id, repo.name);
        repos.push(updated);
    }

    return repos;
}

async function syncParts(client: Client, org: { id: string }, repos: Repo[]): Promise<Part[]> {
    const parts: Part[] = [];

    for (const part of site.parts) {
        const repo = repos.find((r) => r.name === part.repo);
        if (!repo) {
            throw new Error(`No repo named "${part.repo}" for part "${part.key}".`);
        }

        const found = await call<Part | undefined>(client, 'serve.part.find_one', { query: { tenantId: org.id, key: part.key } });

        // No `wants` here in either branch: the spec no longer carries it. It used to
        // (partSpecSchema had its own `wants: []`, always empty, always overwritten), but the row's
        // real value is set by build.ts from the part's own mesh.wants.json -- a hand-written copy
        // of that in the spec could only ever be stale or redundant, never authoritative. Omitting
        // the field leaves the schema's own default (`[]`) on create and leaves the existing value
        // alone on update, so a build's own write is never clobbered by a reconcile that runs after
        // it.
        if (found === undefined) {
            const created = await call<Part>(client, 'serve.part.create', {
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
            });
            console.log('Created part', created.id, part.key);
            parts.push(created);
            continue;
        }

        const updated = await call<Part>(client, 'serve.part.update', {
            id: found.id,
            repoId: repo.id,
            kind: part.kind,
            path: part.path,
            entryPoint: part.entry,
            ...(part.imports !== undefined ? { imports: part.imports } : {}),
            ...(part.description !== undefined ? { description: part.description } : {}),
            ...(part.options !== undefined ? { options: part.options } : {}),
            ...(part.desired !== undefined ? { desired: part.desired } : {}),
        });
        console.log('Part reconciled', updated.id, part.key);
        parts.push(updated);
    }

    return parts;
}

/** `part.ref` if the spec pins one; otherwise resolves the owning repo's branch to its current
 *  commit sha via `git ls-remote`, so the artifact cache below is always keyed by a real commit. */
async function resolveRef(repo: RepoSpec, part: PartSpec): Promise<string> {
    if (part.ref !== undefined) return part.ref;

    const { stdout } = await execFileAsync('git', ['ls-remote', repo.url, repo.ref]);
    const sha = stdout.split('\n')[0]?.split('\t')[0]?.trim();
    if (!sha) {
        throw new Error(`Could not resolve ref "${repo.ref}" on ${repo.url} (part "${part.key}").`);
    }
    return sha;
}

interface ArtifactRow {
    readonly id: string;
    readonly status: 'pending' | 'running' | 'success' | 'failed';
    readonly hash?: string;
    readonly error?: string;
}

/** Ensures each part has a successful artifact at its pinned/resolved commit -- building it if
 *  none exists yet, reusing ("linking") the existing one otherwise. Does not build the release
 *  itself; serve.composition.compose resolves each part's latest successful artifact on its own. */
async function syncArtifacts(client: Client, org: { id: string }, parts: Part[], force: boolean): Promise<void> {
    for (const part of parts) {
        const partSpec = site.parts.find((p) => p.key === part.key);
        const repoSpec = site.repos.find((r) => r.name === partSpec?.repo);
        if (!partSpec || !repoSpec) {
            throw new Error(`No spec for built part "${part.key}".`);
        }

        const ref = await resolveRef(repoSpec, partSpec);
        const shortRef = ref.slice(0, 12);

        const existing = await call<ArtifactRow | undefined>(client, 'serve.artifact.find_one', {
            query: { tenantId: org.id, partId: part.id, ref, status: 'success' },
        });

        if (existing !== undefined && !force) {
            console.log(`Artifact cached for ${part.key}@${shortRef}, linking`, existing.id);
            continue;
        }

        // requestBuild, not a raw artifact.create: `serve.artifact`'s own contract declares
        // create/update/delete internal precisely so every build goes through the validated path
        // (resolving the part, checking driver kinds, defaulting status).
        const build = await call<ArtifactRow>(client, 'serve.artifact.requestBuild', { partId: part.id, ref });
        console.log(`Building ${part.key}@${shortRef}`, build.id);

        // No forced sweep here: serve.artifact.watchRelease is deliberately not exposed (it is
        // reached only through serve.queue's own dispatcher, never by name -- see
        // BOOTSTRAP_EXPOSED_CONTRACTS's own note on why `build` was removed from that list). It
        // already runs on its own 60s interval with no action needed; this just waits for it,
        // exactly what an operator watching a build's progress through the api would do.
        const deadline = Date.now() + 5 * 60_000;
        let artifact = await call<ArtifactRow>(client, 'serve.artifact.get', { id: build.id });
        while (artifact.status === 'pending' || artifact.status === 'running') {
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for ${part.key}@${shortRef} to build (still "${artifact.status}").`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
            artifact = await call<ArtifactRow>(client, 'serve.artifact.get', { id: build.id });
        }

        if (artifact.status !== 'success' || artifact.hash === undefined) {
            throw new Error(`Build failed for ${part.key}@${shortRef}: ${artifact.error ?? 'no successful artifact'}`);
        }
        console.log(`Built ${part.key}@${shortRef}`, artifact.hash);
    }
}

async function syncComposition(client: Client, org: { id: string }, parts: Part[]): Promise<{ id: string }> {
    const kernelPart = parts.find((p) => p.kind === 'kernel');
    if (!kernelPart) {
        throw new Error('No kernel part in spec.');
    }
    const themePart = parts.find((p) => p.kind === 'theme');
    const drivers = parts.filter((p) => p.kind === 'driver');
    const extensions = parts.filter((p) => p.kind === 'extension');
    const applications = parts.filter((p) => p.kind === 'application');
    const services = parts.filter((p) => p.kind === 'service');

    const primary = applications[0];
    if (primary === undefined) {
        throw new Error('No kind: "application" part in spec -- a site needs one to open.');
    }

    const fields = {
        kernelPartKey: kernelPart.id,
        theme: themePart?.id,
        drivers: drivers.map((p) => p.id),
        extensions: extensions.map((p) => p.id),
        applications: applications.map((p) => p.id),
        services: services.map((p) => p.id),
    };

    // Keyed by the primary application's own key, not a fixed 'console' -- one process now hosts
    // more than one site (this file's whole reason to take a --site argument), and a fixed key
    // meant every site after the first silently overwrote the console's own composition instead of
    // getting its own. Not the site's hostname either, which was this fix's first attempt and is
    // wrong for a different reason: deploy.ts requires composition.key === site.application exactly
    // (composing the same application the site was declared to serve), so the composition's key has
    // to be that same application key, not a second identifier of its own.
    const found = await call<{ id: string } | undefined>(client, 'serve.composition.find_one', { query: { tenantId: org.id, key: primary.key } });

    if (found === undefined) {
        const created = await call<{ id: string }>(client, 'serve.composition.create', { tenantId: org.id, key: primary.key, ...fields });
        console.log('Created composition', created.id);
        return created;
    }

    const updated = await call<{ id: string }>(client, 'serve.composition.update', { id: found.id, ...fields });
    console.log('Composition reconciled', updated.id);
    return updated;
}

async function syncRelease(client: Client, compositionId: string): Promise<{ id: string; hash: string; artifacts: readonly unknown[] }> {
    const release = await call<{ id: string; hash: string; artifacts: readonly unknown[] }>(client, 'serve.composition.compose', { id: compositionId });
    console.log('Release', release.hash, `(${release.artifacts.length} artifacts)`);
    return release;
}

interface CdnRow {
    readonly id: string;
    readonly host: string;
    readonly releaseHash?: string;
}

async function syncSite(
    client: Client,
    org: { id: string },
    consoleApi: Api,
    releaseId: string,
    applications: Part[],
): Promise<void> {
    const open = applications.map((p) => ({ application: p.key }));

    // The first application-kind part in declaration order is what the site actually opens; the
    // rest are bundled and available (mesh-web's own `open` list, above) but not launched by
    // default -- e.g. dns.site.yaml composes both platform/domains (primary) and
    // platform/nameserver (a secondary telemetry app, reachable but not the landing page).
    const primary = applications[0];
    if (primary === undefined) {
        throw new Error('No kind: "application" part in spec -- a site needs one to open.');
    }

    const found = await call<CdnRow | undefined>(client, 'serve.cdn.find_one', { query: { tenantId: org.id, host: site.site } });
    // `?? {}` matches the create branch's own default below -- a site spec declaring no `policy`
    // means "nothing frozen," the same as every site before this field existed, not "leave whatever
    // was there" (which is what leaving `policy` out of the update call entirely used to silently do).
    const policy = site.policy ?? {};
    // Empty, not a hardcoded name: serve.cdn's own schema already falls back title to `application`
    // when title is empty, so this is a real default rather than a second place a site's display
    // name could be declared and drift from the first.
    const title = '';

    const cdn = found !== undefined
        ? await call<CdnRow>(client, 'serve.cdn.update', {
            id: found.id, apiId: consoleApi.id, application: primary.key, open, policy,
            title, description: '',
        })
        : await call<CdnRow>(client, 'serve.cdn.create', {
            tenantId: org.id, host: site.site, apiId: consoleApi.id, application: primary.key,
            policy, theme: {}, open,
            title, description: '',
            indexable: false, maintenance: false,
        });

    console.log(found !== undefined ? 'Site reconciled' : 'Site created', cdn.id);

    const deploy = await call<{ site: CdnRow }>(client, 'serve.cdn.deploy', { siteId: cdn.id, releaseId });
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

interface ExposeRow {
    readonly contract: string;
    readonly role?: string;
    readonly permission?: string;
}

async function syncExposed(client: Client, consoleApi: Api): Promise<void> {
    const current = await call<ExposeRow[]>(client, 'serve.expose.find', { query: { apiId: consoleApi.id } });
    const currentByContract = new Map(current.map((row) => [row.contract, row]));
    const desired = new Map(site.api.expose.map((spec) => [spec.contract, spec]));

    for (const [contract, spec] of desired) {
        const existing = currentByContract.get(contract);

        if (existing === undefined) {
            await call(client, 'serve.expose.add', {
                apiId: consoleApi.id, contract,
                ...(spec.gate !== 'public' ? spec.gate : {}),
            });
            console.log('Exposed', contract, gateLabel(spec.gate));
            continue;
        }

        if (!sameGate(gateOfRow(existing), spec.gate)) {
            // No update on this collection (`add`'s own 409 is what enforces "one row per
            // contract"), so changing a gate is remove-then-add, same as a person would do it by
            // hand through expose.remove/expose.add.
            await call(client, 'serve.expose.remove', { apiId: consoleApi.id, contract });
            await call(client, 'serve.expose.add', {
                apiId: consoleApi.id, contract,
                ...(spec.gate !== 'public' ? spec.gate : {}),
            });
            console.log('Regated', contract, gateLabel(spec.gate));
        }
    }

    for (const row of current) {
        if (desired.has(row.contract)) continue;
        if (BOOTSTRAP_OWNED.has(row.contract)) {
            console.log('Leaving', row.contract, '-- bootstrap-owned, not this spec\'s to remove');
            continue;
        }
        await call(client, 'serve.expose.remove', { apiId: consoleApi.id, contract: row.contract });
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
 * before syncExposed tries to publish them -- building the artifact (syncArtifacts, above) never
 * runs the module, only serve.part.start's own require() + loadDomain does that (startService.ts).
 * Idempotent: "already running on this node" is the expected outcome on a rerun, not a failure;
 * anything else still throws.
 */
async function syncServices(client: Client, parts: Part[]): Promise<void> {
    for (const part of parts.filter((p) => p.kind === 'service')) {
        try {
            const started = await call<{ domain: string }>(client, 'serve.part.start', { id: part.id });
            console.log('Started service', part.key, started.domain);
        } catch (err) {
            if (err instanceof ApiError && /already running/i.test(err.message)) {
                console.log('Service already running', part.key);
                continue;
            }
            throw err;
        }
    }
}

async function syncGeneratedClient(client: Client, consoleApi: Api, outPath: string): Promise<void> {
    const generated = await call<{ source: string }>(client, 'serve.api.generateClient', { apiId: consoleApi.id });
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
 * file header for why there is no longer a spec-declared fallback to guess from, and for why this
 * connects over the api (the current `mesh-serve login`/`switch` session) rather than to the mesh.
 */
export async function syncSpec(sitePath: string, outPath?: string, force = false): Promise<void> {
    site = loadSite(sitePath);
    console.log('Site spec', sitePath);

    const client = await connect();
    console.log('Signed in against', client.descriptor.host);

    const org = await resolveOrg(client);

    const consoleApi = await syncApi(client, org);
    const repos = await syncRepos(client, org);
    const parts = await syncParts(client, org, repos);

    await syncArtifacts(client, org, parts, force);
    await syncServices(client, parts);

    const composition = await syncComposition(client, org, parts);
    const release = await syncRelease(client, composition.id);

    const applications = parts.filter((p) => p.kind === 'application');
    await syncSite(client, org, consoleApi, release.id, applications);

    await syncExposed(client, consoleApi);

    if (outPath !== undefined) {
        await syncGeneratedClient(client, consoleApi, outPath);
    } else {
        console.log('No --out given; skipping client generation.');
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
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    });
}
