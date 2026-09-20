#!/usr/bin/env -S npx tsx
/**
 * Composes console.localhost onto a cluster that is already running and already claimed.
 *
 * The sibling `composeConsole.ts` boots its own private single node and does everything in one
 * process. This one joins a cluster you started yourself -- which is the case that matters, because
 * it is the only way to watch the real mechanisms work: builds dispatched through `serve.queue`
 * (which placement loads on demand, on whichever node the sweep runs), a release pinned by content
 * hash, and a site served identically by every node running the cdn.
 *
 * Run it *after* `mesh-serve bootstrap` has claimed the cluster -- it needs the "platform"
 * organization and the `api.localhost` api row to exist, and says so rather than creating them,
 * because claiming a cluster is a decision a person makes once.
 *
 * Idempotent throughout: every step finds-or-creates, and the composition and site are *reconciled*
 * rather than reused, so re-running after changing the part list actually changes the release.
 * Re-running is the normal way to pick up new commits in the source repos.
 *
 *   npx tsx src/examples/composeOnCluster.ts --node ws://127.0.0.1:6801 --db mesh-two-node
 */
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import type { IServiceBroker } from '@flybyme/mesh';

import { CATALOG_DOMAINS } from '../catalog/domains.js';
import { createCorePartPlacement } from '../catalog/methods/corePartPlacement.js';
import '../identity/contracts/organization.contract.js';
import '../cdn/contracts/site.contract.js';
import '../api/contracts/api.contract.js';
import '../api/contracts/expose.contract.js';

void CATALOG_DOMAINS; // imported for its contract registrations, not its list

const REMOTES = '/home/ubuntu/code/.git-remotes';

/** Which repo, at which ref, provides each part of the console. */
const SOURCES = {
    web: { repo: 'mesh-web', url: `${REMOTES}/mesh-web.git`, ref: 'console-demo' },
    core: { repo: 'mesh-core', url: `${REMOTES}/mesh-core.git`, ref: 'master' },
    operator: { repo: 'mesh-operator', url: `${REMOTES}/mesh-operator.git`, ref: 'console-demo' },
} as const;

/**
 * What the console's own api needs reachable. Roles here are the *extrinsic* half -- a contract's
 * own `permissions` is a floor beneath these that an expose row cannot lower.
 */
const IDENTITY_CONTRACTS: readonly { contract: string; role?: string }[] = [
    { contract: 'identity.ticket.issue' },
    { contract: 'identity.ticket.signOut' },
    { contract: 'identity.whoami' },
    { contract: 'identity.user.setPassword' },
    { contract: 'identity.organization.find', role: 'operator' },
    { contract: 'identity.organization.create', role: 'operator' },
    { contract: 'identity.membership.find', role: 'operator' },
    { contract: 'identity.membership.create', role: 'operator' },
    { contract: 'identity.membership.delete', role: 'operator' },
    { contract: 'identity.role.find', role: 'operator' },
];

function arg(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const NODE_URL = arg('node', 'ws://127.0.0.1:6801');
const DB_NAME = arg('db', 'mesh-two-node');
const SITE_HOST = arg('host', 'console.localhost');
const API_HOST = arg('apiHost', 'api.localhost');

const app = new MeshApp({ nodeID: `compose-${String(process.pid)}`, logger: new Logger(LogLevel.ERROR) });
app.use(new RegistryModule({ implementation: PlacementRegistry }));
// Port 0 -- this is a short-lived client that joins, does its work, and leaves; binding a fixed
// port would collide with a second run or with a real node.
app.use(new NetworkModule({
    transports: [new WSTransport(new JSONSerializer(), 0, '127.0.0.1')],
    bootstrapNodes: [NODE_URL],
}));
app.use(new DatabaseModule({ dbName: DB_NAME }));
app.use(new BrokerModule());
await app.start();

const broker = app.getProvider<IServiceBroker>('broker');

// Placement, even though this is a throwaway client: a cluster may legitimately not have identity
// loaded yet, and the provider places a core part on a node that can host one rather than on
// whoever asked. Without it, the first identity call here dies with "no node advertises domain
// identity" while a perfectly good node sits next to it.
broker.setPlacement(createCorePartPlacement(broker));

await new Promise((r) => { setTimeout(r, 2000); });

const claimHint = `Claim the cluster first:\n  npx tsx src/cli/index.ts bootstrap --bootstrapNode ${NODE_URL}`;

const org = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } })
    .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Distinguish "identity is nowhere and cannot be placed" from a real failure, because the
        // first one has an obvious fix and the second does not.
        if (/advertises domain "identity"|Local tool not found/.test(message)) {
            throw new Error(`No node in this cluster is running identity, and none could be asked to.\n${claimHint}`);
        }
        throw err;
    });

if (org === undefined) {
    throw new Error(`No "platform" organization in "${DB_NAME}".\n${claimHint}`);
}
const meta = { meta: { tenant_id: org.id } };
console.log(`Composing ${SITE_HOST} on ${NODE_URL} (org ${org.slug})`);

async function repo(name: string, url: string, branch: string): Promise<{ id: string }> {
    return await broker.call('serve.repo.find_one', { query: { name } }, meta)
        ?? await broker.call('serve.repo.create', { tenantId: org!.id, name, url, defaultBranch: branch }, meta);
}

type Kind = 'kernel' | 'extension' | 'application';
async function part(key: string, repoId: string, kind: Kind, entryPoint: string, imports?: string): Promise<{ id: string; key: string }> {
    return await broker.call('serve.part.find_one', { query: { key } }, meta)
        ?? await broker.call('serve.part.create', {
            tenantId: org!.id, repoId, key, kind, path: '.', entryPoint, wants: [],
            ...(imports !== undefined ? { imports } : {}),
        }, meta);
}

const webRepo = await repo(SOURCES.web.repo, SOURCES.web.url, SOURCES.web.ref);
const coreRepo = await repo(SOURCES.core.repo, SOURCES.core.url, SOURCES.core.ref);
const operatorRepo = await repo(SOURCES.operator.repo, SOURCES.operator.url, SOURCES.operator.ref);

// The kernel must exist before anything else can build: `resolveExternals` is "every *other*
// part's declared imports", so without it an extension's `@flybyme/mesh-web` import is not marked
// external and esbuild tries to resolve a package the extension never depends on directly.
const kernel = await part('platform/kernel', webRepo.id, 'kernel', 'src/index.ts', '@flybyme/mesh-web');
const ui = await part('platform/ui', coreRepo.id, 'extension', 'src/ui/index.ts', '@flybyme/mesh-core/ui');
const auth = await part('platform/auth', coreRepo.id, 'extension', 'src/auth/index.ts', '@flybyme/mesh-core/auth');
const chrome = await part('platform/chrome', coreRepo.id, 'extension', 'src/chrome/index.ts');
const identity = await part('platform/identity', coreRepo.id, 'application', 'src/identity/index.ts');
const operator = await part('platform/console', operatorRepo.id, 'application', 'src/console/index.ts');

const all = [
    { p: kernel, ref: SOURCES.web.ref },
    { p: ui, ref: SOURCES.core.ref },
    { p: auth, ref: SOURCES.core.ref },
    { p: chrome, ref: SOURCES.core.ref },
    { p: identity, ref: SOURCES.core.ref },
    { p: operator, ref: SOURCES.operator.ref },
];
console.log(`parts: ${all.map(({ p }) => p.key).join(', ')}`);

for (const { p, ref } of all) {
    const built = await broker.call('serve.artifact.find', { query: { partId: p.id, status: 'success' } }, meta);
    if (built.length > 0) continue;
    await broker.call('serve.artifact.requestBuild', { partId: p.id, ref }, meta);
    console.log(`  requested build: ${p.key}`);
}

// The sweep runs on its own 60s timer; calling it directly just avoids waiting for the next tick.
// It is leaderScoped, so this reaches whichever node currently leads serve.artifact.
const swept = await broker.call('serve.artifact.watchRelease', {}, meta);
if (swept.enqueued > 0) console.log(`  enqueued ${String(swept.enqueued)} build(s); serve.queue dispatches them`);

const deadline = Date.now() + 900_000;
const settled = new Set<string>();
const failures: { key: string; error: string }[] = [];
while (Date.now() < deadline && settled.size < all.length) {
    for (const { p } of all) {
        if (settled.has(p.key)) continue;
        const rows = await broker.call('serve.artifact.find', { query: { partId: p.id } }, meta);
        const latest = rows[rows.length - 1];
        if (latest?.status === 'success') {
            settled.add(p.key);
            console.log(`  built ${p.key} ${String(latest.hash).slice(0, 12)}`);
        } else if (latest?.status === 'failed') {
            settled.add(p.key);
            failures.push({ key: p.key, error: String(latest.error) });
            console.error(`  FAILED ${p.key}`);
        }
    }
    if (settled.size < all.length) await new Promise((r) => { setTimeout(r, 4000); });
}

// Stop here rather than letting compose throw. It fails on the *first* part it cannot resolve, so
// a five-line stack about one part hides the other four and says nothing about why -- when what a
// reader needs is every failure, and the build output that caused it.
if (failures.length > 0) {
    console.error(`\n${String(failures.length)} of ${String(all.length)} parts did not build:\n`);
    for (const { key, error } of failures) {
        console.error(`--- ${key} ---\n${error.trim()}\n`);
    }
    console.error('Nothing was composed or deployed. Fix the builds and run this again -- parts that');
    console.error('already succeeded are reused, so only the failed ones are rebuilt.');
    await app.stop();
    process.exit(1);
}

if (settled.size < all.length) {
    console.error(`\nTimed out waiting for ${String(all.length - settled.size)} build(s). Nothing was composed.`);
    await app.stop();
    process.exit(1);
}

// Reconciled, not reused: `compose` builds the release from the stored record, so a composition
// left over from an earlier run would silently pin the old part list.
const desired = {
    kernelPartKey: kernel.id,
    drivers: [] as string[],
    extensions: [ui.id, auth.id, chrome.id],
    applications: [identity.id, operator.id],
    services: [] as string[],
};
const existingComposition = await broker.call('serve.composition.find_one', { query: { key: 'console' } }, meta);
const composition = existingComposition === undefined
    ? await broker.call('serve.composition.create', { tenantId: org.id, key: 'console', ...desired }, meta)
    : await broker.call('serve.composition.update', { id: existingComposition.id, ...desired }, meta);

const release = await broker.call('serve.composition.compose', { id: composition.id }, meta);
console.log(`release ${String(release.hash).slice(0, 12)} pinning ${String(release.artifacts.length)} artifacts`);

const api = await broker.call('serve.api.resolveByHost', { apiHost: API_HOST });
if (api === undefined) throw new Error(`No "${API_HOST}" api row -- bootstrap creates it when it claims the cluster.`);

let exposed = 0;
for (const { contract, role } of IDENTITY_CONTRACTS) {
    const already = await broker.call('serve.expose.find_one', { query: { apiId: api.id, contract } }, meta);
    if (already !== undefined) continue;
    await broker.call('serve.expose.add', { apiId: api.id, contract, ...(role !== undefined ? { role } : {}) }, meta);
    exposed += 1;
}
if (exposed > 0) console.log(`exposed ${String(exposed)} contract(s) on ${API_HOST}`);

// `open` decides which Application the kernel actually starts, so an existing site from an earlier
// run has to be updated rather than accepted as-is.
const existingSite = await broker.call('serve.cdn.find_one', { query: { host: SITE_HOST } }, meta);
const site = existingSite === undefined
    ? await broker.call('serve.cdn.create', {
        tenantId: org.id, host: SITE_HOST, apiId: api.id, mcpHost: `mcp-${SITE_HOST}`,
        application: 'console', policy: {}, open: [{ application: operator.key }], theme: {},
        title: 'Console', description: 'The operator console.', indexable: false,
    }, meta)
    : await broker.call('serve.cdn.update', {
        id: existingSite.id, apiId: api.id, open: [{ application: operator.key }],
    }, meta);

const deployed = await broker.call('serve.cdn.deploy', { siteId: site.id, releaseId: release.id }, meta);
console.log(`\n${deployed.site.host} -> ${String(deployed.site.releaseHash).slice(0, 12)}`);
console.log('Open it on any node running the cdn.');

await app.stop();
process.exit(0);
