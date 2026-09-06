/**
 * **M1: publish → build → compose → deploy → GET.**
 *
 * The one test that matters, and the gap A6, B3a and C2a all named: 183 unit tests pass over pure
 * functions and *nothing in this repository had ever executed a CRUD call, bundled a repository, or
 * answered an HTTP request*. The last time that was true of the declaration reader, running it
 * against one real repository found two defects in an afternoon.
 *
 * So this boots a real `MeshApp` with a real database, publishes a real repository from a real git
 * commit, builds it with real esbuild, and fetches the result over real HTTP.
 *
 * It needs mongo on `MONGODB_URI` (default `mongodb://localhost:27017`). Skipped rather than failed
 * when there is none: a suite that goes red on a laptop without a database teaches people to ignore
 * red.
 */

import {
    BrokerModule, DatabaseModule, MeshApp, RegistryModule,
} from '@flybyme/mesh';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BuilderService } from '../../src/builder/builder.service.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { CdnService } from '../../src/cdn/cdn.service.js';

const run = promisify(execFile);
const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const { MongoClient } = await import('mongodb');
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

/** The caller. Every write here is authorized against it, so it is not incidental. */
const ORG = 'org-under-test';
const meta = { user: { id: 'u1', tenant_id: ORG } };

/**
 * A GET with a real `Host` header.
 *
 * **Not `fetch`.** `Host` is a forbidden header name in the fetch specification, so `fetch` drops it
 * silently — the request arrives as `127.0.0.1:<port>`, the cdn finds no site for that hostname, and
 * every assertion below fails as a 404 that looks like a bug in the server. Found by exactly that,
 * on the first run of this file.
 *
 * A cdn is addressed *by hostname*, always: that is the whole of `Host → site → release`. So the
 * test has to speak the protocol the way the proxy in front of it will.
 */
async function get(
    port: number,
    path: string,
    host: string,
    headers: Record<string, string> = {},
    method = 'GET',
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    const { request } = await import('node:http');

    return new Promise((resolve, reject) => {
        const req = request(
            { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { body += chunk; });
                res.on('end', () => {
                    resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

interface World {
    readonly app: MeshApp;
    readonly cdn: CdnService;
    readonly workspace: string;
    readonly repository: string;
    readonly commit: string;
    call<T>(tool: string, params: unknown): Promise<T>;
}

let world: World;

/**
 * A part repository, on disk, with a real commit.
 *
 * Two parts, because a repository that builds several is the case that matters — `surfdns-console`
 * is a chrome extension and an application in one tree — and because it proves they become two
 * independently versioned artifacts rather than one bundle.
 */
async function makeRepository(): Promise<{ path: string; commit: string }> {
    const path = await mkdtemp(join(tmpdir(), 'mesh-fixture-'));
    await mkdir(join(path, 'src'), { recursive: true });

    await writeFile(join(path, 'mesh.json'), JSON.stringify({
        kernel: '^0.3',
        parts: [
            { kind: 'extension', id: 'fixture-chrome', version: '1.0.0', entry: 'src/chrome.ts' },
            { kind: 'application', id: 'fixture-app', version: '1.0.0', entry: 'src/app.ts' },
        ],
    }, null, 4));

    // The framework is `external`, so this compiles without it being installed. That is the rule
    // under test as much as anything: a build does not install.
    await writeFile(join(path, 'src/chrome.ts'), `
import { needs } from '@flybyme/mesh-web';
export default class FixtureChrome { readonly needs = needs('state'); activate() { return {}; } }
`);
    await writeFile(join(path, 'src/app.ts'), `
import { needs } from '@flybyme/mesh-web';
export default class FixtureApp { readonly needs = needs('state'); start() { return {}; } }
`);

    await run('git', ['init', '--quiet', '-b', 'main'], { cwd: path });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
    await run('git', ['config', 'user.name', 'Test'], { cwd: path });
    await run('git', ['add', '-A'], { cwd: path });
    await run('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: path });

    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: path });
    return { path, commit: stdout.trim() };
}

/** A kernel repository. One part, `kind: 'kernel'`, and therefore nothing external. */
async function makeKernelRepository(): Promise<{ path: string; commit: string }> {
    const path = await mkdtemp(join(tmpdir(), 'mesh-kernel-'));
    await mkdir(join(path, 'src'), { recursive: true });

    await writeFile(join(path, 'mesh.json'), JSON.stringify({
        kind: 'kernel', id: 'fixture-kernel', version: '0.3.0', entry: 'src/index.ts',
    }, null, 4));
    await writeFile(join(path, 'src/index.ts'), 'export const start = (c) => c;\n');

    await run('git', ['init', '--quiet', '-b', 'main'], { cwd: path });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
    await run('git', ['config', 'user.name', 'Test'], { cwd: path });
    await run('git', ['add', '-A'], { cwd: path });
    await run('git', ['commit', '--quiet', '-m', 'kernel'], { cwd: path });

    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: path });
    return { path, commit: stdout.trim() };
}

beforeAll(async () => {
    if (!reachable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'mesh-blobs-'));
    const app = new MeshApp({
        nodeID: `spine-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-serve-spine',
    });

    app.use(new RegistryModule());
    app.use(new DatabaseModule({ uri: MONGO, dbName: `mesh-serve-spine-${String(Date.now())}` }));
    app.use(new BrokerModule());
    await app.start();

    const cdn = new CdnService({ port: 0, blobRoot: workspace });

    // After start: registerModule queues into pendingModules before it, and that flush is unawaited.
    await app.registerModule(new CatalogService());
    await app.registerModule(new BuilderService({ blobRoot: workspace }));
    await app.registerModule(cdn);

    const call = <T,>(tool: string, params: unknown): Promise<T> =>
        (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<T> })
            .call(tool, params, { meta });

    const fixture = await makeRepository();
    world = { app, cdn, workspace, repository: fixture.path, commit: fixture.commit, call };

    const kernel = await makeKernelRepository();
    (world as { kernelRepository?: string }).kernelRepository = kernel.path;
    (world as { kernelCommit?: string }).kernelCommit = kernel.commit;
}, 90_000);

afterAll(async () => {
    if (!reachable || world === undefined) return;
    await world.app.stop();
    await rm(world.workspace, { recursive: true, force: true });
    await rm(world.repository, { recursive: true, force: true });
});

describe.skipIf(!reachable)('the spine, end to end', () => {
    it('publishes a kernel and two parts into the catalog', async () => {
        const kernelPath = (world as unknown as { kernelRepository: string }).kernelRepository;
        const kernelCommit = (world as unknown as { kernelCommit: string }).kernelCommit;

        const kernel = await world.call<{ existed: boolean }>('catalog.publish', {
            name: 'fixture-kernel', kind: 'kernel', repository: kernelPath, publisher: ORG,
            version: '0.3.0', commit: kernelCommit, entry: 'src/index.ts',
        });
        expect(kernel.existed).toBe(false);

        for (const [name, kind, entry] of [
            ['fixture-chrome', 'extension', 'src/chrome.ts'],
            ['fixture-app', 'application', 'src/app.ts'],
        ] as const) {
            const published = await world.call<{ existed: boolean }>('catalog.publish', {
                name, kind, repository: world.repository, publisher: ORG,
                version: '1.0.0', commit: world.commit, entry, kernel: '^0.3',
            });
            expect(published.existed).toBe(false);
        }
    });

    it('is idempotent from the same commit and refuses a different one', async () => {
        // A CI job that runs twice is not an error. A version republished from different code is,
        // because every site pinning that range would silently get different bytes.
        const again = await world.call<{ existed: boolean }>('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: world.repository, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
        });
        expect(again.existed).toBe(true);

        await expect(world.call('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: world.repository, publisher: ORG,
            version: '1.0.0', commit: 'b'.repeat(40), entry: 'src/app.ts', kernel: '^0.3',
        })).rejects.toThrow(/immutable|already published/i);
    });

    it('follows a part that moved repositories, because that is not its identity', async () => {
        /**
         * `upsertPart`'s own comment has always said `repository` and `description` may change.
         * Nothing wrote them: the existing-part path returned the id and dropped both, so the
         * **first** publish fixed a part's repository permanently.
         *
         * Not cosmetic, because `build_start` reads `part.repository` rather than the version's. A
         * part first published from a working copy on somebody's laptop was built from that path
         * forever, on every node, at every version — and no republish could move it, because there
         * was no path that wrote the field at all. Found doing exactly that: `clock` and `notes`
         * went into a live catalog pointing at `/home/ubuntu/code/mesh-demos` and stayed there
         * through a republish from GitHub.
         */
        const moved = 'https://github.com/example/moved.git';

        // The **same** version and commit, so this takes the idempotent path and mints nothing.
        // `upsertPart` runs before the version check, which is what makes a move expressible at all
        // without inventing a version whose only purpose is to carry a URL.
        const again = await world.call<{ existed: boolean }>('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: moved, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
        });
        expect(again.existed).toBe(true);

        const part = await world.call<{ repository: string }>('part.find_one', {
            query: { name: 'fixture-app' },
        });
        expect(part.repository).toBe(moved);

        // Identity is still fixed. Moving the source does not make it a different part, and the
        // checks that guard identity are untouched by this.
        await expect(world.call('catalog.publish', {
            name: 'fixture-app', kind: 'extension', repository: moved, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
        })).rejects.toThrow(/kind/i);

        /**
         * **And the versions it already published still name where they came from.**
         *
         * This is the half that makes the move safe rather than merely possible. A rebuild is
         * `git fetch <repository> <commit>`, and while the repository came from the *part* row a
         * move repointed every past version at a repository that has never contained its commit.
         * The failure would not appear at publish time — it would appear on the rebuild path, which
         * is the durability story, on an artifact that had already been evicted.
         */
        const version = await world.call<{ repository?: string; commit: string }>(
            'partVersion.find_one',
            { query: { partName: 'fixture-app', version: '1.0.0' } },
        );
        expect(version.repository).toBe(world.repository);
        expect(version.repository).not.toBe(moved);
        expect(version.commit).toBe(world.commit);

        // Put it back: these run in order against one world, and everything after this builds
        // `fixture-app` from the repository the fixture actually created.
        await world.call('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: world.repository, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
        });
    });

    it('carries presentation on the part and a changelog on the version', async () => {
        /**
         * A5c-i. `part.description` existed from the beginning and **nothing filled it**, because
         * `mesh.json` had no field to fill it from — so a catalog of thirteen parts had thirteen
         * empty descriptions and a marketplace would have been a grid of bare ids.
         *
         * The split under test: **identity is immutable, presentation is not.** A typo in a
         * description must be fixable with a publish rather than a version bump, because a version
         * means *this code*. A changelog is the exception — it describes one version and is frozen
         * with it.
         */
        await world.call('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: world.repository, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
            description: 'A fixture.', homepage: 'https://example.test',
            license: 'MIT', keywords: ['fixture', 'test'], icon: 'icon.svg',
            changelog: 'The first one.',
        });

        const part = await world.call<{
            description: string; homepage?: string; license?: string;
            keywords: string[]; icon?: string;
        }>('part.find_one', { query: { name: 'fixture-app' } });

        expect(part.description).toBe('A fixture.');
        expect(part.homepage).toBe('https://example.test');
        expect(part.license).toBe('MIT');
        expect(part.keywords).toEqual(['fixture', 'test']);
        expect(part.icon).toBe('icon.svg');

        // Corrected without minting a version — the whole point of it living on the part.
        await world.call('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: world.repository, publisher: ORG,
            version: '1.0.0', commit: world.commit, entry: 'src/app.ts', kernel: '^0.3',
            description: 'A fixture, spelled correctly.',
        });

        const fixed = await world.call<{ description: string; license?: string }>(
            'part.find_one', { query: { name: 'fixture-app' } });
        expect(fixed.description).toBe('A fixture, spelled correctly.');

        // And a field the second publish did not mention is left alone rather than cleared: a
        // publisher that knows about `description` and not `license` must not erase a license.
        expect(fixed.license).toBe('MIT');
    });

    it('resolves a range to the published version', async () => {
        const resolved = await world.call<{
            kernel: { version: string }; parts: { name: string; version: string }[];
            unsatisfied: unknown[];
        }>('catalog.resolve', {
            kernel: '^0.3',
            parts: [{ name: 'fixture-app', version: '^1.0' }],
        });

        expect(resolved.unsatisfied).toEqual([]);
        expect(resolved.kernel.version).toBe('0.3.0');
        expect(resolved.parts[0]?.version).toBe('1.0.0');
    });

    it('builds each part into its own artifact', async () => {
        const kernel = await world.call<{ state: string; artifactDigest?: string }>('builder.build_start', {
            part: 'fixture-kernel', version: '0.3.0',
        });
        expect(kernel.state).toBe('succeeded');

        const chrome = await world.call<{ state: string; artifactDigest?: string }>('builder.build_start', {
            part: 'fixture-chrome', version: '1.0.0',
        });
        const app = await world.call<{ state: string; artifactDigest?: string }>('builder.build_start', {
            part: 'fixture-app', version: '1.0.0',
        });

        expect(chrome.state).toBe('succeeded');
        expect(app.state).toBe('succeeded');
        // Two parts from one repository are two artifacts, versioned and replaced independently.
        // That is the whole reason installing an extension is not a site rebuild.
        expect(chrome.artifactDigest).not.toBe(app.artifactDigest);
    }, 60_000);

    it('does not rebuild what it already built', async () => {
        const again = await world.call<{ cached: boolean }>('builder.build_start', {
            part: 'fixture-app', version: '1.0.0',
        });
        expect(again.cached).toBe(true);
    });

    it('refuses to build a part belonging to another organization', async () => {
        // The check that stands between a builder's credential and every repository it can read.
        await expect((world.app as unknown as {
            call(t: string, p: unknown, o?: unknown): Promise<unknown>;
        }).call('builder.build_start', { part: 'fixture-app', version: '1.0.0' }, {
            meta: { user: { id: 'u2', tenant_id: 'someone-else' } },
        })).rejects.toThrow();
    });

    it('composes a release from what was built', async () => {
        const composed = await world.call<{
            hash: string; parts: Record<string, unknown>; problems: unknown[];
        }>('cdn.compose', {
            kernel: '^0.3',
            parts: [
                { kind: 'extension', id: 'fixture-chrome', version: '^1.0' },
                { kind: 'application', id: 'fixture-app', version: '^1.0' },
            ],
        });

        expect(composed.problems).toEqual([]);
        expect(composed.hash).toMatch(/^sha256:/);
        expect(Object.keys(composed.parts).sort()).toEqual(['fixture-app', 'fixture-chrome']);
    });

    it('composing the same set again is the same release', async () => {
        // The property the whole design rests on: two people composing the same set land on the same
        // hash without coordinating, so "staging runs what production runs" is one field comparison.
        const first = await world.call<{ hash: string }>('cdn.compose', {
            kernel: '^0.3', parts: [{ kind: 'application', id: 'fixture-app', version: '^1.0' }],
        });
        const second = await world.call<{ hash: string; existed: boolean }>('cdn.compose', {
            kernel: '^0.3', parts: [{ kind: 'application', id: 'fixture-app', version: '^1.0' }],
        });

        expect(second.hash).toBe(first.hash);
        expect(second.existed).toBe(true);
    });

    it('serves the site over HTTP once it is deployed', async () => {
        const composed = await world.call<{ hash: string }>('cdn.compose', {
            kernel: '^0.3',
            parts: [
                { kind: 'extension', id: 'fixture-chrome', version: '^1.0' },
                { kind: 'application', id: 'fixture-app', version: '^1.0' },
            ],
        });

        await world.call('site.create', {
            host: 'fixture.test', application: 'fixture', tenantId: ORG,
            api: 'http://127.0.0.1:5005', mesh: [], theme: { '--surface': '#161b22' }, policy: {},
            title: 'The fixture site', description: 'Serving from a real cdn.',
        });

        const deployed = await world.call<{ changed: boolean }>('cdn.deploy', {
            host: 'fixture.test', release: composed.hash,
        });
        expect(deployed.changed).toBe(true);

        const port = world.cdn.port!;
        const page = await get(port, '/', 'fixture.test');

        expect(page.status).toBe(200);

        // The metadata is in the document, which is the entire reason the page is generated per
        // request rather than built as an artifact.
        expect(page.body).toContain('<title>The fixture site</title>');
        expect(page.body).toContain('content="Serving from a real cdn."');

        // One kernel, one URL. Two would be two module graphs and two of every singleton.
        expect(page.body).toContain('"@flybyme/mesh-web"');
        expect(page.body).toContain('--surface: #161b22;');

        // A page is reached by a mutable name, so it must not be cached.
        expect(page.headers['cache-control']).toBe('no-cache');

        // And the artifacts it names are actually fetchable from this node's disk.
        const mapped = /"@flybyme\/mesh-web": "([^"]+)"/.exec(page.body)?.[1];
        expect(mapped).toBeDefined();

        const kernel = await get(port, mapped!, 'fixture.test');
        expect(kernel.status).toBe(200);
        // Named by its own hash, so it is immutable with no judgement call.
        expect(kernel.headers['cache-control']).toContain('immutable');
        expect(kernel.body).toContain('start');
    }, 30_000);

    it('revalidates a page it has already sent', async () => {
        const port = world.cdn.port!;
        const first = await get(port, '/', 'fixture.test');
        const etag = first.headers['etag'] as string;

        const again = await get(port, '/', 'fixture.test', { 'if-none-match': etag });
        expect(again.status).toBe(304);
    });

    it('404s an artifact the release does not contain', async () => {
        // Without the check, `/_a/<any digest>/` is an open proxy into every other tenant's code,
        // served from this site's origin.
        const answer = await get(world.cdn.port!, '/_a/deadbeefdeadbeef/index.js', 'fixture.test');
        expect(answer.status).toBe(404);
    });

    it('404s a hostname nobody configured', async () => {
        const answer = await get(world.cdn.port!, '/', 'nobody.test');
        expect(answer.status).toBe(404);
    });

    it('refuses a method that would change something', async () => {
        // A cdn serves. Anything that changes state goes to the API, which is the only security
        // boundary — a cdn accepting a POST would be a second one.
        const answer = await get(world.cdn.port!, '/', 'fixture.test', {}, 'POST');
        expect(answer.status).toBe(405);
    });
});
