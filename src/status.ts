/**
 * What the cluster actually is, in one screen.
 *
 * **Read-only, and that is the whole contract.** It joins as a temporary peer, asks, prints, and
 * leaves. It creates nothing, assigns nothing and deploys nothing, so it is safe to run against a
 * live cluster while something else is mid-deploy — which is exactly when you want it.
 *
 * ```
 * npx tsx src/status.ts --bootstrap ws://169.197.131.82:4001 --org flybyme
 * ```
 *
 * ## Why it is not just a dump
 *
 * Every fact here was already reachable through a contract, and reaching them one at a time is how
 * an evening goes. The value is the last section: **the things that are individually valid and
 * jointly wrong.** A site pointing at a release nobody kept. A version published and never built. A
 * granted event whose collection cannot be scoped, so it is delivered to nobody and the list that
 * subscribes to it stays silent for ever. None of those is an error anywhere — each component is
 * behaving correctly — and none of them is visible from inside any single one.
 */

import {
    BrokerModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
    type IServiceBroker,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactCrud, buildCrud } from './builder/contracts/artifact.contract.js';
import { partCrud, partVersionCrud } from './catalog/contracts/part.contract.js';
import { edgeCrud } from './cdn/contracts/edge.contract.js';
import { releaseCrud } from './cdn/contracts/release.contract.js';
import { siteCrud } from './cdn/contracts/site.contract.js';
import { groupCrud, nodeCrud } from './fleet/contracts/node.contract.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
    // A loopback cluster with no key needs none.
}

// ---------------------------------------------------------------------------- drawing

const NO_COLOUR = argv.includes('--no-colour') || argv.includes('--no-color')
    || process.env['NO_COLOR'] !== undefined;

const paint = (code: string) => (text: string): string =>
    (NO_COLOUR ? text : `[${code}m${text}[0m`);

const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

/** Visible width, so alignment survives the escape codes above. */
const width = (text: string): number => text.replace(/\[[0-9;]*m/g, '').length;
const pad = (text: string, to: number): string => text + ' '.repeat(Math.max(0, to - width(text)));

function section(title: string): void {
    console.log(`\n${bold(title)}\n${dim('─'.repeat(Math.max(24, title.length)))}`);
}

/** A table that lines up regardless of colour, and says so when there is nothing in it. */
function table(rows: readonly (readonly string[])[], empty = 'nothing'): void {
    if (rows.length === 0) {
        console.log(dim(`  (${empty})`));
        return;
    }
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
    for (const row of rows) {
        console.log(`  ${row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ')}`.trimEnd());
    }
}

const short = (hash: string | undefined): string =>
    hash === undefined ? dim('none') : hash.replace(/^sha256:/, '').slice(0, 12);

const ago = (when: Date | string | undefined): string => {
    if (when === undefined) return dim('—');
    const ms = Date.now() - new Date(when).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${String(mins)}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${String(hours)}h ago` : `${String(Math.round(hours / 24))}d ago`;
};

// ---------------------------------------------------------------------------- joining

interface Probe {
    broker: IServiceBroker;
    /** Nodes the registry can see right now, which is a different question from what the fleet records. */
    peers: readonly string[];
    stop(): Promise<void>;
}

async function connect(bootstrap: readonly string[]): Promise<Probe> {
    const app = new MeshApp({ nodeID: `status-${Date.now().toString(36)}` });
    app.use(new RegistryModule());
    app.use(new NetworkModule({
        port: 0,
        transports: [new WSTransport(new JSONSerializer(), 0)],
        bootstrapNodes: [...bootstrap],
    }));
    app.use(new BrokerModule());
    await app.start();

    // Give the mesh a moment to exchange presence, or the first read races the tools it needs.
    await app.registry.waitForTool('part.find', 15_000).catch(() => undefined);

    return {
        broker: app.getProvider<IServiceBroker>('broker'),
        peers: (app.registry.getNodes?.() ?? [])
            .map((n: { nodeID: string }) => n.nodeID)
            .filter((id: string) => !id.startsWith('status-')),
        stop: () => app.stop(),
    };
}

/**
 * Ask, and treat a refusal as an answer.
 *
 * Half of what this tool reports is *whether a read is even permitted*, so a throw is information
 * rather than a failure — a scoped collection refusing an unscoped caller is the system working,
 * and a status tool that died on it would be useless against exactly the clusters worth inspecting.
 */
async function ask<T>(run: () => Promise<T>, fallback: T): Promise<{ value: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (error) {
        return { value: fallback, error: error instanceof Error ? error.message : String(error) };
    }
}

// ---------------------------------------------------------------------------- the report

interface Finding {
    readonly level: 'error' | 'warn';
    readonly what: string;
    readonly why: string;
}

/**
 * Which collections can stream their CRUD events, from the collection definitions themselves.
 *
 * An event is delivered by narrowing it to each subscriber, so an event on a collection with no
 * `scopedBy` can be narrowed to nobody and reaches nobody. The API says so at deploy time, in one
 * paragraph per event, and the consequence is quiet: a console list that subscribes to it simply
 * never updates. Read from the contracts rather than listed here, so this cannot drift from them.
 */
const COLLECTIONS = [
    { name: 'site', crud: siteCrud },
    { name: 'release', crud: releaseCrud },
    { name: 'edge', crud: edgeCrud },
    { name: 'part', crud: partCrud },
    { name: 'partVersion', crud: partVersionCrud },
    { name: 'artifact', crud: artifactCrud },
    { name: 'build', crud: buildCrud },
    { name: 'node', crud: nodeCrud },
    { name: 'group', crud: groupCrud },
] as const;

const scopedByOf = (name: string): string | undefined =>
    (COLLECTIONS.find((c) => c.name === name)?.crud as { scopedBy?: string } | undefined)?.scopedBy;

async function report(): Promise<void> {
    const bootstrap = flag('bootstrap', process.env['MESH_BOOTSTRAP'] ?? 'ws://127.0.0.1:4001')
        .split(',').map((s) => s.trim()).filter((s) => s !== '');

    const probe = await connect(bootstrap);
    const findings: Finding[] = [];

    try {
        // ------------------------------------------------------------------ who we are asking as
        const orgSlug = flag('org', '');
        const orgs = await ask(() => probe.broker.call('organization.find', { query: {}, limit: 50 }), []);
        const org = orgSlug === ''
            ? orgs.value[0]
            : orgs.value.find((o: { slug: string }) => o.slug === orgSlug);

        if (org === undefined && orgs.value.length > 0) {
            console.log(red(`No organization "${orgSlug}". Known: ${orgs.value.map((o: { slug: string }) => o.slug).join(', ')}`));
            return;
        }

        const orgId = (org as { id: string } | undefined)?.id ?? '';
        const as = {
            meta: {
                organizationId: orgId,
                tenantId: orgId,
                user: { id: 'status', tenant_id: orgId, roles: ['operator'] },
            },
        };

        console.log(`\n${bold('mesh-serve')}  ${dim(bootstrap.join(', '))}`);
        console.log(`${dim('as')} ${(org as { slug?: string } | undefined)?.slug ?? dim('no organization')} ${dim(orgId)}`);

        // ------------------------------------------------------------------ fleet
        section('FLEET');
        const nodes = await ask(() => probe.broker.call('node.find', { query: {}, limit: 100 }, as), []);
        const connected = new Set(probe.peers);

        table([
            [dim('HOSTNAME'), dim('LIVE'), dim('DESIRED'), dim('GROUPS'), dim('SEEN')],
            ...nodes.value.map((n: {
                hostname: string; services?: string[]; groups?: string[]; updatedAt?: Date;
            }) => [
                n.hostname,
                connected.has(n.hostname) ? green('up') : red('down'),
                (n.services ?? []).join(',') || dim('core only'),
                (n.groups ?? []).join(',') || dim('—'),
                ago(n.updatedAt),
            ]),
        ], 'no nodes have said hello');

        for (const n of nodes.value as { hostname: string; services?: string[] }[]) {
            if (!connected.has(n.hostname) && (n.services ?? []).length > 0) {
                findings.push({
                    level: 'warn',
                    what: `${n.hostname} is offline but still assigned ${(n.services ?? []).join(', ')}`,
                    why: 'Desired state outlives the machine, which is correct — but nothing is running those services.',
                });
            }
        }

        // Peers the registry sees that the fleet has no row for: a node that joined and never
        // registered, which is invisible to every fleet screen while being fully on the mesh.
        const known = new Set((nodes.value as { hostname: string }[]).map((n) => n.hostname));
        for (const peer of probe.peers) {
            if (!known.has(peer) && !peer.startsWith('bringup-') && !peer.startsWith('status-')) {
                findings.push({
                    level: 'warn',
                    what: `${peer} is on the mesh with no fleet record`,
                    why: 'It can serve calls but cannot be assigned, and no console lists it.',
                });
            }
        }

        // ------------------------------------------------------------------ catalog
        section('CATALOG');
        const parts = await ask(() => probe.broker.call('part.find', { query: {}, limit: 200 }, as), []);
        const versions = await ask(
            () => probe.broker.call('partVersion.find', { query: {}, limit: 1000 }, as), [],
        );

        const byPart = new Map<string, { version: string; artifactDigest?: string; state: string; publishedAt: Date }[]>();
        for (const v of versions.value as {
            partName: string; version: string; artifactDigest?: string; state: string; publishedAt: Date;
        }[]) {
            const list = byPart.get(v.partName) ?? [];
            list.push(v);
            byPart.set(v.partName, list);
        }

        const newest = (name: string) => [...(byPart.get(name) ?? [])]
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0];

        table([
            [dim('PART'), dim('KIND'), dim('VERSIONS'), dim('LATEST'), dim('ARTIFACT'), dim('PUBLISHED')],
            ...(parts.value as { name: string; kind: string }[])
                .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind < b.kind ? -1 : 1))
                .map((p) => {
                    const latest = newest(p.name);
                    return [
                        p.name,
                        p.kind === 'kernel' ? cyan(p.kind) : dim(p.kind),
                        String((byPart.get(p.name) ?? []).length),
                        latest?.version ?? dim('—'),
                        latest?.artifactDigest === undefined ? red('none') : short(latest.artifactDigest),
                        ago(latest?.publishedAt),
                    ];
                }),
        ], 'no parts published');

        for (const [name, list] of byPart) {
            const unbuilt = list.filter((v) => v.artifactDigest === undefined);
            if (unbuilt.length > 0) {
                findings.push({
                    level: 'warn',
                    what: `${name} has ${String(unbuilt.length)} version(s) with no artifact: ${unbuilt.map((v) => v.version).join(', ')}`,
                    why: 'Published and never built. A composition naming one is refused as a missing part.',
                });
            }
        }

        // ------------------------------------------------------------------ releases
        section('RELEASES');
        const releases = await ask(
            () => probe.broker.call('release.find', { query: {}, limit: 200 }, as), [],
        );

        type Rel = {
            hash: string; name: string; kernel: { version: string }; parts: Record<string, unknown>;
            rolling?: boolean; supersededBy?: string; composedAt: Date; requires?: string[];
        };
        const rels = [...(releases.value as Rel[])]
            .sort((a, b) => new Date(b.composedAt).getTime() - new Date(a.composedAt).getTime())
            .slice(0, Number(flag('releases', '8')));

        table([
            [dim('RELEASE'), dim('NAME'), dim('KERNEL'), dim('PARTS'), dim('ROLLING'), dim('COMPOSED')],
            ...rels.map((r) => [
                short(r.hash),
                r.name === '' ? dim('—') : r.name,
                r.kernel.version,
                String(Object.keys(r.parts).length),
                r.rolling === true ? green('yes') : r.supersededBy !== undefined
                    ? dim(`→ ${short(r.supersededBy)}`) : dim('no'),
                ago(r.composedAt),
            ]),
        ], 'nothing composed');

        const rollingCount = (releases.value as Rel[]).filter((r) => r.rolling === true).length;
        console.log(dim(`  ${String((releases.value as Rel[]).length)} total, ${String(rollingCount)} rolling`));

        // ------------------------------------------------------------------ sites
        section('SITES');
        const sites = await ask(() => probe.broker.call('site.find', { query: {}, limit: 100 }, as), []);

        if (sites.error !== undefined) {
            console.log(red(`  cannot read: ${sites.error}`));
        }

        type Site = {
            host: string; api: string; releaseHash?: string; application: string;
            mesh: { contracts: { key: string }[]; events?: { key: string }[] }[];
        };
        const byHash = new Map((releases.value as Rel[]).map((r) => [r.hash, r]));

        table([
            [dim('HOST'), dim('APP'), dim('RELEASE'), dim('KERNEL'), dim('GRANTS'), dim('EVENTS')],
            ...(sites.value as Site[]).map((s) => {
                const rel = s.releaseHash === undefined ? undefined : byHash.get(s.releaseHash);
                const contracts = s.mesh.flatMap((m) => m.contracts).length;
                const events = s.mesh.flatMap((m) => m.events ?? []).length;
                return [
                    s.host,
                    s.application,
                    s.releaseHash === undefined ? red('not deployed') : short(s.releaseHash),
                    rel?.kernel.version ?? (s.releaseHash === undefined ? dim('—') : red('missing')),
                    String(contracts),
                    String(events),
                ];
            }),
        ], 'no sites');

        for (const s of sites.value as Site[]) {
            if (s.releaseHash !== undefined && !byHash.has(s.releaseHash)) {
                findings.push({
                    level: 'error',
                    what: `${s.host} points at release ${short(s.releaseHash)}, which does not exist`,
                    why: 'The hostname resolves to nothing servable. Deploy a release that exists.',
                });
            }

            /**
             * **The granted event that can never arrive.**
             *
             * This is the check worth having. An event is delivered by narrowing it to a
             * subscriber, so one whose collection declares no `scopedBy` is delivered to nobody —
             * and nothing fails: the stream opens, the subscription succeeds, and the list that
             * depends on it is simply never updated again. The API says so once, at deploy, in a
             * paragraph most people scroll past.
             */
            const dead = s.mesh.flatMap((m) => m.events ?? [])
                .map((e) => e.key)
                .filter((key) => scopedByOf(key.slice(0, key.indexOf('.'))) === undefined);

            if (dead.length > 0) {
                findings.push({
                    level: 'warn',
                    what: `${s.host} grants ${String(dead.length)} event(s) that can never be delivered`,
                    why: `${[...new Set(dead.map((k) => k.slice(0, k.indexOf('.'))))].join(', ')} `
                        + `declare no scopedBy, so nothing can be narrowed to a subscriber. Any list `
                        + `subscribing to them stays silent for ever — see roadmap D7.`,
                });
            }
        }

        // ------------------------------------------------------------------ collections
        section('COLLECTIONS');
        table([
            [dim('COLLECTION'), dim('SCOPED BY'), dim('READS'), dim('EVENTS STREAM')],
            ...COLLECTIONS.map(({ name, crud }) => {
                const scoped = scopedByOf(name);
                const vis = (crud as { visibility?: Record<string, string> }).visibility?.['find'] ?? 'internal';
                return [
                    name,
                    scoped ?? dim('global'),
                    vis === 'public' ? (scoped === undefined ? yellow('public') : green('public')) : dim(vis),
                    scoped === undefined ? red('no') : green('yes'),
                ];
            }),
        ]);
        console.log(dim('  public reads on a collection with no scope return every tenant\'s rows'));

        for (const { name, crud } of COLLECTIONS) {
            const scoped = scopedByOf(name);
            const vis = (crud as { visibility?: Record<string, string> }).visibility?.['find'];
            if (vis === 'public' && scoped === undefined && !['part', 'partVersion', 'artifact'].includes(name)) {
                findings.push({
                    level: 'error',
                    what: `${name}.find is public and unscoped`,
                    why: 'Every read returns every organization\'s rows. part, partVersion and artifact are '
                        + 'global on purpose and say so; this one is not.',
                });
            }
        }

        // ------------------------------------------------------------------ findings
        section('WHAT IS WRONG');
        if (findings.length === 0) {
            console.log(green('  nothing found'));
        } else {
            for (const f of findings) {
                console.log(`  ${f.level === 'error' ? red('✗') : yellow('!')} ${bold(f.what)}`);
                console.log(`    ${dim(f.why)}`);
            }
        }
        console.log('');
    } finally {
        await probe.stop();
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    report().catch((error: unknown) => {
        console.error('status failed:', error);
        process.exit(1);
    });
}

export { report };
