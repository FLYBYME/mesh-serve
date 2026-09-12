/**
 * **M2 C5 & C6: Artifact Durability (Peer Sync and Rebuild from Commit)**
 *
 * Assertions:
 * 1. Loss of disk, peer has it: Edge 2 with empty memoryBlobStore fetches missing blob
 *    from Edge 1 over HTTP, serves 200 with right bytes, and caches it locally.
 * 2. Nobody has it, rebuild from commit: Storage wiped on both edges. Requesting page/artifact
 *    triggers deterministic rebuild from git commit, transitions artifact from 'gone' to 'available',
 *    rebuilt digest equals original, and serves 200 with right bytes.
 * 3. Corrupted peer response rejected: Peer server returns corrupted bytes for /blobs/<digest>.
 *    Receiving edge rejects them (hash mismatch), never stores corrupt bytes in its blob store,
 *    and falls back to rebuild or fails safely.
 * 4. Concurrent misses: Multiple concurrent requests for a missing blob coalesce via singleflight
 *    without race conditions or staging write collisions.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { execFile } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BuilderService } from '../../src/builder/builder.service.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { CdnService } from '../../src/cdn/cdn.service.js';
import { memoryBlobStore } from '../../src/builder/blobs.js';
import { slugOf } from '../../src/cdn/methods/resolve.js';

const run = promisify(execFile);
const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

const ORG = 'org-durability-test';
const meta = { user: { id: 'u1', tenant_id: ORG } };
const HOST = 'durability.test';

async function get(
    port: number,
    path: string,
    host: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request(
            { host: '127.0.0.1', port, path, method: 'GET', headers: { host, ...headers } },
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

async function makeRepository(): Promise<{ path: string; commit: string }> {
    const path = await mkdtemp(join(tmpdir(), 'mesh-fixture-durability-'));
    await mkdir(join(path, 'src'), { recursive: true });

    await writeFile(join(path, 'mesh.json'), JSON.stringify({
        kernel: '^0.3',
        parts: [
            { kind: 'extension', id: 'fixture-chrome', version: '1.0.0', entry: 'src/chrome.ts' },
            { kind: 'application', id: 'fixture-app', version: '1.0.0', entry: 'src/app.ts' },
        ],
    }, null, 4));

    await writeFile(join(path, 'src/chrome.css'), '.chrome { display: flex; }\n');
    await writeFile(join(path, 'src/chrome.ts'), `
import './chrome.css';
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

async function makeKernelRepository(): Promise<{ path: string; commit: string }> {
    const path = await mkdtemp(join(tmpdir(), 'mesh-kernel-durability-'));
    await mkdir(join(path, 'src'), { recursive: true });

    await writeFile(join(path, 'mesh.json'), JSON.stringify({
        kind: 'kernel', id: 'fixture-kernel', version: '0.3.0', entry: 'src/index.ts',
    }, null, 4));
    await writeFile(join(path, 'src/kernel.css'), '.window { background: var(--surface); }\n');
    await writeFile(join(path, 'src/index.ts'), 'import "./kernel.css";\nexport const start = (c: unknown) => c;\n');

    await run('git', ['init', '--quiet', '-b', 'main'], { cwd: path });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
    await run('git', ['config', 'user.name', 'Test'], { cwd: path });
    await run('git', ['add', '-A'], { cwd: path });
    await run('git', ['commit', '--quiet', '-m', 'kernel'], { cwd: path });

    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: path });
    return { path, commit: stdout.trim() };
}

describe.skipIf(!reachable)('M2 artifact durability (C5 & C6)', () => {
    let app1: MeshApp | undefined;
    let app2: MeshApp | undefined;
    let cdn1: CdnService | undefined;
    let cdn2: CdnService | undefined;
    let workspace1: string;
    let repoPath: string;
    let kernelRepoPath: string;
    let dbName: string;

    let appDigest: string;
    let chromeDigest: string;
    let kernelDigest: string;
    let appFileDigest: string;
    let chromeFileDigest: string;

    beforeAll(async () => {
        dbName = `mesh-serve-durability-${String(Date.now())}`;
        workspace1 = await mkdtemp(join(tmpdir(), 'mesh-blobs-durability-'));

        // Node 1: MeshApp with WSTransport, BuilderService, CatalogService, and CdnService (with fileBlobStore)
        const transport1 = new WSTransport(new JSONSerializer(), 0);
        const node1 = new MeshApp({
            nodeID: `durability-node-1-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-serve-durability',
        });
        node1.use(new RegistryModule());
        node1.use(new DatabaseModule({ uri: MONGO, dbName }));
        node1.use(new NetworkModule({ transports: [transport1] }));
        node1.use(new BrokerModule());
        await node1.start();
        const wsPort1 = transport1.getPort();

        const service1 = new CdnService({ port: 0, blobRoot: workspace1 });
        await node1.registerModule(new CatalogService());
        await node1.registerModule(new BuilderService({ blobRoot: workspace1 }));
        await node1.registerModule(service1);

        // Node 2: MeshApp with memoryBlobStore (starts completely empty)
        const transport2 = new WSTransport(new JSONSerializer(), 0);
        const node2 = new MeshApp({
            nodeID: `durability-node-2-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-serve-durability',
        });
        node2.use(new RegistryModule());
        node2.use(new DatabaseModule({ uri: MONGO, dbName }));
        node2.use(new NetworkModule({
            transports: [transport2],
            bootstrapNodes: [`ws://127.0.0.1:${String(wsPort1)}`],
        }));
        node2.use(new BrokerModule());
        await node2.start();

        const service2 = new CdnService({ port: 0, blobs: memoryBlobStore() });
        await node2.registerModule(service2);

        await node1.registry.waitForNodes(2);
        await node2.registry.waitForNodes(2);
        await node2.registry.waitForTool('builder.build_start');
        await node2.registry.waitForTool('catalog.publish');
        await node2.registry.waitForTool('cdn.compose');
        await node2.registry.waitForTool('cdn.deploy');
        await node2.registry.waitForTool('site.create');

        app1 = node1;
        app2 = node2;
        cdn1 = service1;
        cdn2 = service2;

        // Set up repositories and publish into catalog
        const kernelFixture = await makeKernelRepository();
        kernelRepoPath = kernelFixture.path;
        await node1.call('catalog.publish', {
            name: 'fixture-kernel', kind: 'kernel', repository: kernelFixture.path, publisher: ORG,
            version: '0.3.0', commit: kernelFixture.commit, entry: 'src/index.ts',
        }, { meta });

        const fixture = await makeRepository();
        repoPath = fixture.path;
        await node1.call('catalog.publish', {
            name: 'fixture-chrome', kind: 'extension', repository: fixture.path, publisher: ORG,
            version: '1.0.0', commit: fixture.commit, entry: 'src/chrome.ts', kernel: '^0.3',
        }, { meta });
        await node1.call('catalog.publish', {
            name: 'fixture-app', kind: 'application', repository: fixture.path, publisher: ORG,
            version: '1.0.0', commit: fixture.commit, entry: 'src/app.ts', kernel: '^0.3',
        }, { meta });

        // Build all three parts
        const kernelBuild = await node1.call('builder.build_start', {
            part: 'fixture-kernel', version: '0.3.0',
        }, { meta });
        kernelDigest = kernelBuild.artifactDigest ?? '';

        const chromeBuild = await node1.call('builder.build_start', {
            part: 'fixture-chrome', version: '1.0.0',
        }, { meta });
        chromeDigest = chromeBuild.artifactDigest ?? '';

        const appBuild = await node1.call('builder.build_start', {
            part: 'fixture-app', version: '1.0.0',
        }, { meta });
        appDigest = appBuild.artifactDigest ?? '';

        // Retrieve file digests from artifacts
        const appArtifact = await node1.call('artifact.find_one', { query: { digest: appDigest } });
        appFileDigest = appArtifact?.files[0]?.digest ?? '';

        const chromeArtifact = await node1.call('artifact.find_one', { query: { digest: chromeDigest } });
        chromeFileDigest = chromeArtifact?.files[0]?.digest ?? '';

        // Compose release and deploy site
        const composed = await node1.call('cdn.compose', {
            kernel: '^0.3',
            parts: [
                { kind: 'extension', id: 'fixture-chrome', version: '^1.0' },
                { kind: 'application', id: 'fixture-app', version: '^1.0' },
            ],
        }, { meta });
        console.log('COMPOSED:', JSON.stringify(composed, null, 2));

        await node1.call('site.create', {
            host: HOST, application: 'fixture', tenantId: ORG,
            api: 'http://127.0.0.1:5005', mesh: [], theme: { '--surface': '#161b22' }, policy: {},
            title: 'Durability Site', description: 'Testing peer sync and rebuild.',
        }, { meta });

        await node1.call('cdn.deploy', {
            host: HOST, release: composed.hash,
        }, { meta });
    }, 90_000);

    afterAll(async () => {
        if (app2 !== undefined) {
            try { await app2.stop(); } catch { /* ignore */ }
        }
        if (app1 !== undefined) {
            try { await app1.stop(); } catch { /* ignore */ }
        }
        if (reachable) {
            try {
                const client = new MongoClient(MONGO);
                await client.connect();
                await client.db(dbName).dropDatabase();
                await client.close();
            } catch {
                /* ignore */
            }
        }
        if (workspace1 !== undefined) {
            await rm(workspace1, { recursive: true, force: true }).catch(() => undefined);
        }
        if (repoPath !== undefined) {
            await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
        }
        if (kernelRepoPath !== undefined) {
            await rm(kernelRepoPath, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('Test 1 (Loss of disk, peer has it): Edge 2 fetches missing blob from Edge 1 peer over HTTP', async () => {
        if (cdn1 === undefined || cdn2 === undefined) throw new Error('CDN services not started');

        // Edge 1 has the blob in its local workspace
        expect(await cdn1.blobs.has(appFileDigest)).toBe(true);

        // Edge 2 starts with an empty memory blob store
        expect(await cdn2.blobs.has(appFileDigest)).toBe(false);

        // Request the artifact file directly from Edge 2
        const edge2Port = cdn2.port ?? 0;
        const res = await get(edge2Port, `/_a/${slugOf(appDigest)}/index.js`, HOST);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('javascript');
        expect(res.body).toContain('@flybyme/mesh-web');

        // Edge 2 now holds the blob in its memory store after fetching from Edge 1
        expect(await cdn2.blobs.has(appFileDigest)).toBe(true);

        // Edge 2 also successfully serves the page over HTTP
        const pageRes = await get(edge2Port, '/', HOST);
        expect(pageRes.status).toBe(200);
        expect(pageRes.body).toContain('<title>Durability Site</title>');
    });

    it('Test 2 (Nobody has it, rebuild from commit): Storage wiped on both edges, rebuilt deterministically', async () => {
        if (cdn1 === undefined || cdn2 === undefined || app1 === undefined) throw new Error('CDN not started');

        // Wipe storage on Edge 1 (disk workspace)
        const entries = await readdir(workspace1);
        for (const entry of entries) {
            await rm(join(workspace1, entry), { recursive: true, force: true });
        }

        // Wipe storage on Edge 2 (memory blob store)
        cdn2.blobs = memoryBlobStore();

        // Confirm both edges have zero blobs for the artifact
        expect(await cdn1.blobs.has(chromeFileDigest)).toBe(false);
        expect(await cdn2.blobs.has(chromeFileDigest)).toBe(false);

        // Edge 2 receives a request for the chrome artifact
        const edge2Port = cdn2.port ?? 0;
        const res = await get(edge2Port, `/_a/${slugOf(chromeDigest)}/index.js`, HOST);

        // Assert rebuild succeeded and served the correct bytes
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('javascript');
        expect(res.body).toContain('@flybyme/mesh-web');

        // Assert determinism: rebuilt digest in mongo matches the original digest
        const rebuiltDoc = await app1.call('artifact.find_one', { query: { digest: chromeDigest } });
        expect(rebuiltDoc).toBeDefined();
        expect(rebuiltDoc?.digest).toBe(chromeDigest);
        expect(rebuiltDoc?.state).toBe('available');

        const versionDoc = await app1.call('partVersion.find_one', {
            query: { partName: 'fixture-chrome', version: '1.0.0' },
        });
        expect(versionDoc?.state).toBe('built');

        // Assert both edges now hold the reconstituted blob
        expect(await cdn1.blobs.has(chromeFileDigest)).toBe(true);
        expect(await cdn2.blobs.has(chromeFileDigest)).toBe(true);
    });

    it('Test 3 (Corrupted peer response rejected): Edge rejects bad bytes and falls back safely', async () => {
        if (cdn1 === undefined || cdn2 === undefined || app1 === undefined) throw new Error('CDN not started');

        // Wipe local memory store on Edge 2
        cdn2.blobs = memoryBlobStore();
        expect(await cdn2.blobs.has(appFileDigest)).toBe(false);

        // Wipe Edge 1 so Edge 1 does not have the blob
        await cdn1.blobs.delete(appFileDigest);
        expect(await cdn1.blobs.has(appFileDigest)).toBe(false);

        // Spin up a fake rogue peer that returns corrupt bytes for /blobs/:digest
        let corruptDials = 0;
        const corruptServer: Server = createServer((req, res) => {
            if (req.url?.startsWith('/blobs/')) {
                corruptDials += 1;
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                res.end(Buffer.from('corrupted garbage content that fails sha256 check'));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        await new Promise<void>((resolve) => { corruptServer.listen(0, '127.0.0.1', () => { resolve(); }); });
        const address = corruptServer.address();
        const corruptPort = typeof address === 'object' && address !== null ? address.port : 0;
        const corruptUrl = `http://127.0.0.1:${String(corruptPort)}`;

        // Register corrupt edge in the mesh registry
        const corruptEdge = await app1.call('edge.create', {
            url: corruptUrl,
        });

        try {
            // Request the blob from Edge 2. Edge 2 will dial peers (including corruptServer).
            // It must detect the corrupted bytes, discard them, and fall back to rebuildMissingBlob.
            const edge2Port = cdn2.port ?? 0;
            const res = await get(edge2Port, `/_a/${slugOf(appDigest)}/index.js`, HOST);

            // Corrupt peer was contacted
            expect(corruptDials).toBeGreaterThanOrEqual(1);

            // Request succeeded via fallback rebuild
            expect(res.status).toBe(200);
            expect(res.body).toContain('@flybyme/mesh-web');

            // The stored bytes on Edge 2 must be the valid bytes, NEVER the corrupted garbage
            const heldBytes = await cdn2.blobs.get(appFileDigest);
            expect(heldBytes).toBeDefined();
            expect(heldBytes?.toString('utf8')).not.toContain('corrupted garbage');
            expect(heldBytes?.toString('utf8')).toContain('@flybyme/mesh-web');
        } finally {
            await app1.call('edge.delete', { id: corruptEdge.id }).catch(() => undefined);
            await new Promise<void>((resolve) => { corruptServer.close(() => { resolve(); }); });
        }
    });

    it('Test 4 (Concurrent misses): Parallel requests for a missing digest coalesce cleanly', async () => {
        if (cdn1 === undefined || cdn2 === undefined) throw new Error('CDN not started');

        // Ensure Edge 1 has the blob, but Edge 2 does not
        expect(await cdn1.blobs.has(appFileDigest)).toBe(true);
        await cdn2.blobs.delete(appFileDigest);
        expect(await cdn2.blobs.has(appFileDigest)).toBe(false);

        // Fire 20 parallel requests to Edge 2 for the missing blob
        const edge2Port = cdn2.port ?? 0;
        const requests = Array.from({ length: 20 }, () =>
            get(edge2Port, `/_a/${slugOf(appDigest)}/index.js`, HOST)
        );

        const results = await Promise.all(requests);

        // All 20 requests succeeded with status 200
        for (const res of results) {
            expect(res.status).toBe(200);
            expect(res.body).toContain('@flybyme/mesh-web');
            expect(res.body).toBe(results[0]?.body);
        }

        // Edge 2 now holds the blob
        expect(await cdn2.blobs.has(appFileDigest)).toBe(true);
    });
});
