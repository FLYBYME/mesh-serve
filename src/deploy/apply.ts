/**
 * What deploy changes on the api: the site's api and its exposures, its repos and parts, a build of
 * each part at an exact ref, the composition and its release, and the site record. Each step finds
 * before it creates, so a run with nothing changed changes nothing.
 *
 * Every call goes through the api the CLI is signed in to, as the operator, like any other command
 * (`sync`, which this replaces, learned that the hard way: it once went around the api). Every
 * answer is parsed with a schema of the fields used here -- an api that answers something else is
 * stopped at the step that asked, not three steps later.
 */
import { z } from 'zod';

import { ApiError, callApi, describeApi } from '../cli/core/apiClient.js';
import { isLive, readSession } from '../cli/core/session.js';
import { BOOTSTRAP_EXPOSED_CONTRACTS } from '../api/ensureBootstrapApi.js';
import type { ExposureDescriptor } from '../api/methods/descriptor.js';
import type { ExposeSpec, SiteSpec } from './spec.js';

export interface ApiSession {
    readonly apiUrl: string;
    readonly token: string;
    readonly descriptor: ExposureDescriptor;
}

/** The signed-in api, described fresh: deploy changes what it exposes. */
export async function connect(): Promise<ApiSession> {
    const session = await readSession();
    if (session.apiUrl === undefined) throw new Error('Not pointed at an api. Run `mesh-serve switch <url>` first.');
    const token = session.token;
    if (token === undefined || !isLive(session)) throw new Error('No live ticket. Run `mesh-serve login` first.');

    const descriptor = await describeApi(session.apiUrl);

    return { apiUrl: session.apiUrl, token, descriptor };
}

/** One call by its key, its answer checked against `schema`. */
export async function ask<S extends z.ZodTypeAny>(api: ApiSession, key: string, params: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const found = api.descriptor.calls.find((c) => c.key === key);
    if (found === undefined) throw new Error(`"${key}" is not exposed on ${api.descriptor.host}: deploy needs it.`);

    const raw = await callApi(api.apiUrl, found, params, api.token);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`${key} answered what deploy cannot read: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);

    return parsed.data;
}

const Row = z.object({ id: z.string() });
const ApiRow = Row.extend({ apiHost: z.string() });
const RepoRow = Row.extend({ name: z.string() });
const PartRow = Row.extend({ key: z.string(), kind: z.string() });
export const ArtifactRow = Row.extend({
    status: z.enum(['pending', 'running', 'success', 'failed']),
    commit: z.string().optional(),
    error: z.string().optional(),
    duration: z.number().optional(),
});
const ReleaseRow = Row.extend({ hash: z.string().optional(), artifacts: z.array(Row) });
export const CdnRow = Row.extend({ host: z.string(), application: z.string(), releaseHash: z.string().optional() });
const ExposeRow = z.object({ contract: z.string(), role: z.string().optional(), permission: z.string().optional() });
const Who = z.object({ organizations: z.array(z.object({ organizationId: z.string() })) });

export type Part = z.infer<typeof PartRow>;
export type Artifact = z.infer<typeof ArtifactRow>;
export type Release = z.infer<typeof ReleaseRow>;
export type Cdn = z.infer<typeof CdnRow>;

const maybe = <S extends z.ZodTypeAny>(schema: S) => z.union([schema, z.null(), z.undefined()]);

/** The organization everything here belongs to: the signed-in operator's own. */
export async function organization(api: ApiSession): Promise<string> {
    const who = await ask(api, 'identity.whoami', {}, Who);
    const org = who.organizations[0];
    if (org === undefined) throw new Error('The signed-in account belongs to no organization.');

    return org.organizationId;
}

/** The site's api's id, if it is there. */
export async function findApi(api: ApiSession, spec: SiteSpec): Promise<string | undefined> {
    const found = await ask(api, 'serve.api.find_one', { query: { apiHost: spec.api.host } }, maybe(ApiRow));

    return found?.id;
}

export async function siteApi(api: ApiSession, spec: SiteSpec, tenantId: string): Promise<{ id: string; made: boolean }> {
    const found = await findApi(api, spec);
    if (found !== undefined) return { id: found, made: false };

    const created = await ask(api, 'serve.api.create', { tenantId, apiHost: spec.api.host, description: `Api for ${spec.site}` }, ApiRow);

    return { id: created.id, made: true };
}

export async function repos(api: ApiSession, spec: SiteSpec, tenantId: string): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    for (const repo of spec.repos) {
        const found = await ask(api, 'serve.repo.find_one', { query: { tenantId, url: repo.url } }, maybe(RepoRow));
        const credential = repo.credential !== undefined ? { credential: repo.credential } : {};

        const row = found !== null && found !== undefined
            ? await ask(api, 'serve.repo.update', { id: found.id, name: repo.name, defaultBranch: repo.ref, ...credential }, RepoRow)
            : await ask(api, 'serve.repo.create', { tenantId, name: repo.name, url: repo.url, defaultBranch: repo.ref, ...credential }, RepoRow);

        ids.set(repo.name, row.id);
    }

    return ids;
}

export async function parts(api: ApiSession, spec: SiteSpec, tenantId: string, repoIds: ReadonlyMap<string, string>): Promise<Part[]> {
    const out: Part[] = [];

    for (const part of spec.parts) {
        const repoId = repoIds.get(part.repo);
        if (repoId === undefined) throw new Error(`No repo named "${part.repo}" for part "${part.key}".`);

        const fields = {
            repoId, kind: part.kind, path: part.path, entryPoint: part.entry,
            ...(part.imports !== undefined ? { imports: part.imports } : {}),
            ...(part.description !== undefined ? { description: part.description } : {}),
            ...(part.options !== undefined ? { options: part.options } : {}),
            ...(part.desired !== undefined ? { desired: part.desired } : {}),
        };
        const found = await ask(api, 'serve.part.find_one', { query: { tenantId, key: part.key } }, maybe(PartRow));

        const row = found !== null && found !== undefined
            ? await ask(api, 'serve.part.update', { id: found.id, ...fields }, PartRow)
            : await ask(api, 'serve.part.create', { tenantId, key: part.key, ...fields }, PartRow);

        out.push(row);
    }

    return out;
}

/** How long one build may take before deploy stops waiting for it. */
const BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * A successful build of `part` at `ref`: the one already there (unless `force`), else a new one,
 * waited for. An api that does not answer while it builds is "still building" until the deadline:
 * a rerun would build again.
 */
export async function build(api: ApiSession, tenantId: string, part: Part, ref: string, force: boolean, say: (line: string) => void): Promise<Artifact> {
    const cached = await ask(api, 'serve.artifact.find_one', { query: { tenantId, partId: part.id, ref, status: 'success' } }, maybe(ArtifactRow));
    if (cached !== null && cached !== undefined && !force) {
        say(`${part.key}@${ref.slice(0, 12)}: built already (${cached.id})`);
        return cached;
    }

    const requested = await ask(api, 'serve.artifact.requestBuild', { partId: part.id, ref }, ArtifactRow);
    const deadline = Date.now() + BUILD_TIMEOUT_MS;

    let artifact = requested;
    while (artifact.status === 'pending' || artifact.status === 'running') {
        if (Date.now() > deadline) throw new Error(`Build ${requested.id} of ${part.key} still ${artifact.status} after ${BUILD_TIMEOUT_MS / 60_000} minutes.`);

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const next = await ask(api, 'serve.artifact.get', { id: requested.id }, ArtifactRow).catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 0) return undefined;
            throw err;
        });
        if (next === undefined) say(`  (the api is not answering while ${part.key} builds; still waiting)`);
        else artifact = next;
    }

    if (artifact.status === 'failed') throw new Error(`Build ${artifact.id} of ${part.key}@${ref} failed:\n${artifact.error ?? '(no error recorded)'}`);

    say(`${part.key}@${ref.slice(0, 12)}: built ${artifact.id} of ${artifact.commit?.slice(0, 7) ?? '?'} in ${artifact.duration ?? '?'} s`);

    return artifact;
}

/** The composition, keyed by the first application's key (a site serves the composition of the application it names). */
export async function composition(api: ApiSession, tenantId: string, built: readonly Part[]): Promise<{ id: string; key: string }> {
    const kernel = built.find((p) => p.kind === 'kernel');
    if (kernel === undefined) throw new Error('No kind: kernel part in the site file.');

    const applications = built.filter((p) => p.kind === 'application');
    const primary = applications[0];
    if (primary === undefined) throw new Error('No kind: application part in the site file: a site needs one to open.');

    const fields = {
        kernelPartKey: kernel.id,
        theme: built.find((p) => p.kind === 'theme')?.id,
        drivers: built.filter((p) => p.kind === 'driver').map((p) => p.id),
        extensions: built.filter((p) => p.kind === 'extension').map((p) => p.id),
        applications: applications.map((p) => p.id),
        services: built.filter((p) => p.kind === 'service').map((p) => p.id),
    };
    const found = await ask(api, 'serve.composition.find_one', { query: { tenantId, key: primary.key } }, maybe(Row));

    const row = found !== null && found !== undefined
        ? await ask(api, 'serve.composition.update', { id: found.id, ...fields }, Row)
        : await ask(api, 'serve.composition.create', { tenantId, key: primary.key, ...fields }, Row);

    return { id: row.id, key: primary.key };
}

/** A release of the composition, refused unless it holds exactly the builds deploy made or found. */
export async function release(api: ApiSession, compositionId: string, builds: readonly Artifact[]): Promise<Release> {
    const made = await ask(api, 'serve.composition.compose', { id: compositionId }, ReleaseRow);

    const missing = builds.filter((b) => !made.artifacts.some((a) => a.id === b.id));
    // compose takes each part's newest build: an older one found by ref is not it. --force builds again.
    if (missing.length > 0) throw new Error(`Release ${made.id} does not hold build(s) ${missing.map((b) => b.id).join(', ')} (a newer build of the part is the one composed): deploy --force builds them again.`);

    return made;
}

export async function findSite(api: ApiSession, spec: SiteSpec, tenantId: string): Promise<Cdn | undefined> {
    const found = await ask(api, 'serve.cdn.find_one', { query: { tenantId, host: spec.site } }, maybe(CdnRow));

    return found ?? undefined;
}

/** The site record as the file says, then pointed at the release. */
export async function site(api: ApiSession, spec: SiteSpec, tenantId: string, apiId: string, application: string, existing: Cdn | undefined, releaseId: string): Promise<Cdn> {
    const head = {
        apiId, application, policy: spec.policy ?? {},
        title: spec.title, description: spec.description, indexable: spec.indexable, pages: spec.pages,
        ...(spec.canonical !== undefined ? { canonical: spec.canonical } : {}),
    };
    const applications = spec.parts.filter((p) => p.kind === 'application').map((p) => ({ application: p.key }));

    const record = existing !== undefined
        ? await ask(api, 'serve.cdn.update', { id: existing.id, ...head, ...(spec.open !== undefined ? { open: spec.open } : {}) }, CdnRow)
        : await ask(api, 'serve.cdn.create', {
            tenantId, host: spec.site, ...head, open: spec.open ?? applications, theme: {}, maintenance: false,
        }, CdnRow);

    const deployed = await ask(api, 'serve.cdn.deploy', { siteId: record.id, releaseId }, z.object({ site: CdnRow }));

    return deployed.site;
}

function gateOfRow(row: z.infer<typeof ExposeRow>): ExposeSpec['gate'] {
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

const gateParams = (gate: ExposeSpec['gate']) => (gate === 'public' ? { public: true } : gate);

/** Never removed by a site's deploy: the bootstrap api's own management rows. */
const BOOTSTRAP_OWNED = new Set(BOOTSTRAP_EXPOSED_CONTRACTS.map((c) => c.contract));

export interface ExposureChange {
    readonly contract: string;
    readonly change: 'expose' | 'regate' | 'unexpose';
}

/**
 * The api's rows made to match the file's `expose` list: added, regated, removed. `apply: false`
 * only says what would change. Rows the bootstrap api owns are never removed.
 */
export async function exposures(api: ApiSession, spec: SiteSpec, apiId: string, apply: boolean): Promise<ExposureChange[]> {
    const listed = spec.api.expose;
    if (listed === undefined) return [];

    const current: z.infer<typeof ExposeRow>[] = [];
    for (let offset = 0; ; offset += 500) {
        const page = await ask(api, 'serve.expose.find', { query: { apiId }, limit: 500, offset }, z.array(ExposeRow));
        current.push(...page);
        if (page.length < 500) break;
    }

    const byContract = new Map(current.map((row) => [row.contract, row]));
    const wanted = new Map(listed.map((e) => [e.contract, e]));
    const changes: ExposureChange[] = [];

    for (const [contract, e] of wanted) {
        const row = byContract.get(contract);
        if (row !== undefined && sameGate(gateOfRow(row), e.gate)) continue;

        changes.push({ contract, change: row === undefined ? 'expose' : 'regate' });
        if (!apply) continue;

        if (row !== undefined) await ask(api, 'serve.expose.remove', { apiId, contract }, z.unknown());
        await ask(api, 'serve.expose.add', { apiId, contract, ...gateParams(e.gate) }, z.unknown());
    }

    for (const row of current) {
        if (wanted.has(row.contract) || BOOTSTRAP_OWNED.has(row.contract)) continue;

        changes.push({ contract: row.contract, change: 'unexpose' });
        if (apply) await ask(api, 'serve.expose.remove', { apiId, contract: row.contract }, z.unknown());
    }

    return changes;
}
