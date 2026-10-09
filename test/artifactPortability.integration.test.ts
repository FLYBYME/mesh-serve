/**
 * ~/.mesh/artifacts is plain node-local disk, written only by whichever node ran the build. Once
 * placement can send a `kind: 'service'` part to a *different* node (pinned via nodeSelector, or
 * picked automatically by placementFor), that node has to fetch the build's bytes before it can
 * load them -- startService.ts's ensureArtifactPresent, backed by the new internal
 * serve.artifact.fetchAssetBytes contract.
 *
 * Two real nodes, each given a genuinely separate artifact directory via the setTestArtifactDir
 * test seam (artifacts.ts) -- the only way to make "present on node A, absent on node B" a real
 * filesystem fact rather than a same-process coincidence, since both nodes otherwise share one real
 * ~/.mesh/artifacts on the test runner's own disk.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GridFSBucket, MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { Database, IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import { setTestArtifactDir, clearTestArtifactDirs } from '../src/catalog/methods/artifacts.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-artifact-portability-integration-test';
const A_WS = 16575;
const B_WS = 16576;
const ORG_SLUG = 'portability-org';

async function bootNode(nodeID: string, ws: number, bootstrapNode?: string): Promise<MeshApp> {
    const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
    const app = new MeshApp({ nodeID, logger: new Logger(LogLevel.ERROR) });
    app.use(new RegistryModule({ implementation: PlacementRegistry }));
    app.use(new NetworkModule({
        transports: [new WSTransport(new JSONSerializer(), ws, '127.0.0.1')],
        ...(bootstrapNode !== undefined ? { bootstrapNodes: [bootstrapNode] } : {}),
    }));
    app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
    app.use(new BrokerModule());
    await app.start();

    const broker = app.getProvider<IServiceBroker>('broker');
    for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
    return app;
}

describe('a service part started on a node that never built it', () => {
    let appA: MeshApp;
    let appB: MeshApp;
    let brokerA: IServiceBroker;
    let dirA: string;
    let dirB: string;
    let tenantId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-artifacts-a-'));
        dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-artifacts-b-'));
        setTestArtifactDir('port-a', dirA);
        setTestArtifactDir('port-b', dirB);

        appA = await bootNode('port-a', A_WS);
        brokerA = appA.getProvider<IServiceBroker>('broker');
        appB = await bootNode('port-b', B_WS, `ws://127.0.0.1:${A_WS}`);
        await appB.getProvider<IServiceBroker>('broker').loadDomain('identity', {}, { resolve: resolveHandler });
        await new Promise((r) => { setTimeout(r, 1500); });

        const owner = await brokerA.call('identity.user.create', {
            email: 'port@node.invalid', displayName: 'Port', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        const org = await brokerA.call('identity.organization.create', { slug: ORG_SLUG, name: 'Portability', ownerId: owner.id });
        tenantId = org.id;
    }, 40000);

    afterAll(async () => {
        await appB?.stop();
        await appA?.stop();
        clearTestArtifactDirs();
        await fs.rm(dirA, { recursive: true, force: true });
        await fs.rm(dirB, { recursive: true, force: true });
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('fetches the build from the node that produced it, and starts', async () => {
        const meta = { meta: { tenant_id: tenantId } };

        const repo = await brokerA.call('serve.repo.create', {
            tenantId, name: 'port-repo', url: '/tmp/nonexistent.git', defaultBranch: 'master',
        }, meta);
        const part = await brokerA.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/widget`, kind: 'service',
            path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta);

        // A real, minimal ESM bundle -- the same shape a real esbuild -- format esm output takes
        // (see build.ts's runEsbuild), written directly rather than actually built, since this test
        // is about artifact *portability*, not the build pipeline itself.
        const hash = 'test-portability-hash-0001';
        await fs.mkdir(path.join(dirA, hash), { recursive: true });
        await fs.writeFile(
            path.join(dirA, hash, 'entry.js'),
            'export async function register(broker) { return "portabilityWidget"; }\nexport default register;\n',
        );

        const artifact = await brokerA.call('serve.artifact.create', {
            tenantId, partId: part.id, ref: 'test', status: 'success',
            hash, assets: [{ url: 'entry.js', name: 'entry.js', fileExtension: '.js' }],
            builtOn: 'port-a',
        }, meta);
        expect(artifact.builtOn).toBe('port-a');

        // Never on B's disk to begin with -- dirB is empty.
        await expect(fs.access(path.join(dirB, hash, 'entry.js'))).rejects.toThrow();

        // ensureArtifactPresent (the fetch-on-miss logic under test) runs first and completes --
        // that's what the assertions below check. startService then falls through to
        // ensureArtifactNodeModules, pre-existing code untouched here, which resolves
        // `@flybyme/mesh` via import.meta.resolve -- something Vitest's SSR module transform does
        // not implement, and nothing before this test ever drove a real serve.part.start far enough
        // under `vitest run` to hit (registerShapeRestart.integration.test.ts calls
        // loadAndRegisterModule directly for exactly this kind of reason). That failure crosses the
        // mesh from node B back to node A as a generic wire error, so it isn't pattern-matched here
        // -- this call is expected to reject regardless of the reason, and the real assertion is the
        // filesystem check that follows.
        await brokerA.call('serve.part.start', { id: part.id }, { nodeID: 'port-b', meta: meta.meta })
            .then(
                () => { throw new Error('expected this call to fail past ensureArtifactNodeModules under vitest -- see comment above; if it now succeeds, assert on its result instead'); },
                () => undefined,
            );

        // The real assertion: B's own disk now genuinely has the file, fetched from A.
        const fetched = await fs.readFile(path.join(dirB, hash, 'entry.js'), 'utf8');
        const original = await fs.readFile(path.join(dirA, hash, 'entry.js'), 'utf8');
        expect(fetched).toBe(original);
    }, 30000);

    /** A build written only into port-a's folder, recorded as built by `builders` (newest first). */
    async function buildOnA(name: string, builders: string[]): Promise<string> {
        const meta = { meta: { tenant_id: tenantId } };
        const repo = await brokerA.call('serve.repo.create', { tenantId, name: `${name}-repo`, url: `/tmp/${name}.git`, defaultBranch: 'master' }, meta);
        const part = await brokerA.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/${name}`, kind: 'application', path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta);
        const hash = (name.repeat(64).replace(/[^0-9a-f]/g, 'a') + 'f'.repeat(64)).slice(0, 64);
        await fs.mkdir(path.join(dirA, hash, 'assets'), { recursive: true });
        await fs.writeFile(path.join(dirA, hash, 'index.js'), `export default "${name}";\n`);
        await fs.writeFile(path.join(dirA, hash, 'assets', 'style.css'), `.${name} { color: red }\n`);
        for (const builtOn of [...builders].reverse()) {
            await brokerA.call('serve.artifact.create', {
                tenantId, partId: part.id, ref: 'test', status: 'success', hash, builtOn,
                assets: [{ url: 'index.js', name: 'index.js', fileExtension: '.js' }, { url: 'assets/style.css', name: 'style.css', fileExtension: '.css' }],
            }, meta);
            await new Promise((r) => { setTimeout(r, 5); });
        }
        return hash;
    }

    it('pulls a whole build the website asks for onto the node that lacks it (serve.artifact.pull)', async () => {
        const hash = await buildOnA('site', ['port-a']);
        const onB = { nodeID: 'port-b', meta: { tenant_id: tenantId } };
        await expect(brokerA.call('serve.artifact.getAsset', { artifactHash: hash, path: 'index.js' }, { nodeID: 'port-b' })).rejects.toThrow(/No asset/);

        expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB)).toEqual({ artifactHash: hash, from: 'port-a' });
        expect(await fs.readFile(path.join(dirB, hash, 'assets', 'style.css'), 'utf8')).toBe('.site { color: red }\n');
        expect((await brokerA.call('serve.artifact.getAsset', { artifactHash: hash, path: 'index.js' }, { nodeID: 'port-b' })).contentLength).toBeGreaterThan(0);
        // Already here: nothing copied again.
        expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB)).toEqual({ artifactHash: hash, from: 'local' });
    }, 20000);

    it('copies a build once for many requests at the same moment, never leaving half a file', async () => {
        const hash = await buildOnA('burst', ['port-a']);
        const onB = { nodeID: 'port-b', meta: { tenant_id: tenantId } };
        const results = await Promise.all(Array.from({ length: 5 }, () => brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB)));
        expect(results.every((r) => r.from === 'port-a' || r.from === 'local')).toBe(true);
        const files = await fs.readdir(path.join(dirB, hash));
        expect(files.filter((f) => f.endsWith('.pulling'))).toEqual([]);
        expect(await fs.readFile(path.join(dirB, hash, 'index.js'), 'utf8')).toBe('export default "burst";\n');
    }, 20000);

    it('falls back to another node that built the same hash when the newest builder is gone', async () => {
        const hash = await buildOnA('fallback', ['port-gone', 'port-a']);
        const onB = { nodeID: 'port-b', meta: { tenant_id: tenantId } };
        expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB)).toEqual({ artifactHash: hash, from: 'port-a' });
    }, 30000);

    describe('serve.artifact.importBuild -- a build made outside, brought in as if the builder made it', () => {
        const files = { 'register.js': 'export default async function register() { return "imported"; }\n', 'register.js.map': '{}' };
        const asInput = (f: Record<string, string>) => Object.entries(f).map(([p, c]) => ({ path: p, contentBase64: Buffer.from(c).toString('base64') }));
        const hashOf = async (f: Record<string, string>): Promise<string> => {
            const { hashOutput } = await import('../src/catalog/methods/build.js');
            return hashOutput(new Map(Object.entries(f).map(([p, c]) => [p, Buffer.from(c)]))).hash;
        };
        const newPart = async (name: string): Promise<string> => {
            const meta = { meta: { tenant_id: tenantId } };
            const repo = await brokerA.call('serve.repo.create', { tenantId, name: `${name}-repo`, url: `/tmp/${name}.git`, defaultBranch: 'master' }, meta);
            const part = await brokerA.call('serve.part.create', {
                tenantId, repoId: repo.id, key: `${ORG_SLUG}/${name}`, kind: 'service', path: '.', entryPoint: 'src/register.ts', wants: [],
            }, meta);
            return part.id;
        };
        const commit = 'c'.repeat(40);

        it('stores it on the node that ran the import, records a successful build there, and another node pulls it', async () => {
            const partId = await newPart('imported');
            const hash = await hashOf(files);
            const onA = { nodeID: 'port-a', meta: { tenant_id: tenantId } };
            const artifact = await brokerA.call('serve.artifact.importBuild', {
                partId, ref: 'master', commit, hash, wants: ['identity.whoami'], pin: true, files: asInput(files),
            }, onA);

            expect(artifact).toMatchObject({ status: 'success', hash, builtOn: 'port-a', imported: true, commit, ref: 'master' });
            expect(artifact.assets?.map((a) => a.url)).toEqual(['register.js', 'register.js.map']);
            expect(artifact.assets?.[0]?.integrity).toMatch(/^sha384-/);
            expect(await fs.readFile(path.join(dirA, hash, 'register.js'), 'utf8')).toBe(files['register.js']);
            const part = await brokerA.call('serve.part.resolve', { id: partId }, onA);
            expect(part).toMatchObject({ artifactId: artifact.id, wants: ['identity.whoami'] });

            // Already copied to a second node by the import itself (methods/spreadArtifact.ts).
            expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, { nodeID: 'port-b', meta: { tenant_id: tenantId } }))
                .toEqual({ artifactHash: hash, from: 'local' });
        }, 20000);

        describe('on two node disks, and out of the database (10-09)', () => {
            const onNode = (nodeID: string) => ({ nodeID, meta: { tenant_id: tenantId } });
            const bucket = (): GridFSBucket => {
                const db = brokerA.getProvider<Database>('database').getDb();
                if (!db) throw new Error('no database');
                return new GridFSBucket(db, { bucketName: 'artifactFiles' });
            };
            const inDatabase = async (hash: string): Promise<string[]> => (await bucket().find({ 'metadata.hash': hash }).toArray()).map((x) => x.filename).sort();
            const importOn = async (name: string, f: Record<string, string>): Promise<string> => {
                const partId = await newPart(name);
                const hash = await hashOf(f);
                await brokerA.call('serve.artifact.importBuild', { partId, ref: 'master', commit, hash, files: asInput(f) }, onNode('port-a'));
                return hash;
            };
            /** A build from before 10-09: on port-a's disk and in the database, on no other node. Pinned, so retention keeps it. */
            const storedOnly = async (name: string, f: Record<string, string>): Promise<{ hash: string; id: string }> => {
                const partId = await newPart(name);
                const { hashOutput } = await import('../src/catalog/methods/build.js');
                const { storeArtifact } = await import('../src/catalog/methods/artifactStore.js');
                const made = hashOutput(new Map(Object.entries(f).map(([p, c]) => [p, Buffer.from(c)])));
                for (const [p, c] of Object.entries(f)) {
                    await fs.mkdir(path.join(dirA, made.hash), { recursive: true });
                    await fs.writeFile(path.join(dirA, made.hash, p), c);
                }
                await storeArtifact(brokerA, made.hash, Object.keys(f), 'port-a');
                const record = await brokerA.call('serve.artifact.create', {
                    tenantId, partId, ref: 'master', commit, status: 'success', hash: made.hash, assets: made.assets, builtOn: 'port-a',
                }, { meta: { tenant_id: tenantId } });
                await brokerA.call('serve.part.update', { id: partId, artifactId: record.id }, { meta: { tenant_id: tenantId } });
                return { hash: made.hash, id: record.id };
            };
            const recordOf = async (id: string) => brokerA.call('serve.artifact.resolve', { id }, { meta: { tenant_id: tenantId } });

            it('copies an imported build to a second node, records it, and writes nothing to the database', async () => {
                const f = { 'kept.js': 'export default "kept";\n', 'kept.css': '.k{}' };
                const hash = await importOn('kept', f);

                expect(await fs.readFile(path.join(dirB, hash, 'kept.js'), 'utf8')).toBe(f['kept.js']);
                const [record] = await brokerA.call('serve.artifact.find', { query: { hash } }, { meta: { tenant_id: tenantId } });
                expect(record).toMatchObject({ builtOn: 'port-a', heldBy: ['port-b'] });
                expect(await inDatabase(hash)).toEqual([]);
            }, 20000);

            it('gets a build back from the other holder when the builder\'s disk is gone', async () => {
                const f = { 'lost.js': 'export default "lost disk";\n' };
                const hash = await importOn('lostdisk', f);
                await fs.rm(path.join(dirA, hash), { recursive: true, force: true });

                expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, onNode('port-a'))).toEqual({ artifactHash: hash, from: 'port-b' });
                expect(await fs.readFile(path.join(dirA, hash, 'lost.js'), 'utf8')).toBe(f['lost.js']);
            }, 20000);

            it('moves a build from the database onto two nodes, and only then removes its database files', async () => {
                const f = { 'old.js': 'export default "from before";\n' };
                const { hash, id } = await storedOnly('moved', f);
                expect(await inDatabase(hash)).toEqual([`${hash}/old.js`]);

                const dry = await brokerA.call('serve.artifact.moveOffDatabase', { dryRun: true, limit: 200 }, onNode('port-a'));
                expect(dry).toMatchObject({ dryRun: true, short: [] });
                expect(await inDatabase(hash)).toEqual([`${hash}/old.js`]);

                const moved = await brokerA.call('serve.artifact.moveOffDatabase', { limit: 200 }, onNode('port-a'));
                expect(moved).toMatchObject({ dryRun: false, short: [], left: 0 });
                expect(await fs.readFile(path.join(dirB, hash, 'old.js'), 'utf8')).toBe(f['old.js']);
                expect(await recordOf(id)).toMatchObject({ heldBy: ['port-b'] });
                expect(await inDatabase(hash)).toEqual([]);
            }, 30000);

            it('a build only the database has is put back onto two nodes before it leaves the database', async () => {
                const f = { 'only.js': 'export default "database only";\n' };
                const { hash, id } = await storedOnly('dbonly', f);
                await fs.rm(path.join(dirA, hash), { recursive: true, force: true });

                const moved = await brokerA.call('serve.artifact.moveOffDatabase', { limit: 200 }, onNode('port-a'));
                expect(moved.short).toEqual([]);
                expect(await fs.readFile(path.join(dirA, hash, 'only.js'), 'utf8')).toBe(f['only.js']);
                expect(await fs.readFile(path.join(dirB, hash, 'only.js'), 'utf8')).toBe(f['only.js']);
                expect(await recordOf(id)).toMatchObject({ builtOn: 'port-a', heldBy: ['port-b'] });
                expect(await inDatabase(hash)).toEqual([]);
            }, 30000);

            it('prunes a node\'s disk: an old build nothing keeps goes, a pinned one and a fresh one stay', async () => {
                const pinned = await storedOnly('diskkept', { 'k.js': 'export default "kept on disk";\n' });
                const orphan = path.join(dirA, 'orphan-build-hash');
                const fresh = path.join(dirA, 'fresh-build-hash');
                for (const dir of [orphan, fresh]) {
                    await fs.mkdir(dir, { recursive: true });
                    await fs.writeFile(path.join(dir, 'x.js'), 'export default 0;\n');
                }
                const old = new Date(Date.now() - 2 * 3600_000);
                await fs.utimes(orphan, old, old);
                await fs.utimes(path.join(dirA, pinned.hash), old, old);
                await fs.mkdir(path.join(dirA, `${pinned.hash}.restoring-x`), { recursive: true });

                const dry = await brokerA.call('serve.artifact.pruneDisk', { dryRun: true }, onNode('port-a'));
                expect(dry).toMatchObject({ nodeID: 'port-a', dryRun: true, removed: 1 });
                await expect(fs.access(orphan)).resolves.toBeUndefined();

                const done = await brokerA.call('serve.artifact.pruneDisk', {}, onNode('port-a'));
                expect(done).toMatchObject({ removed: 1 });
                await expect(fs.access(orphan)).rejects.toThrow();
                await expect(fs.access(fresh)).resolves.toBeUndefined();
                await expect(fs.access(path.join(dirA, pinned.hash))).resolves.toBeUndefined();
                await expect(fs.access(path.join(dirA, `${pinned.hash}.restoring-x`))).resolves.toBeUndefined();
            }, 30000);

            it('refuses a hash that is a path', async () => {
                await expect(brokerA.call('serve.artifact.getAsset', { artifactHash: '..', path: 'etc/passwd' }, onNode('port-a'))).rejects.toThrow(/not a build hash/);
            });

            it('never uses a copy in the database that does not match the build\'s record -- it rebuilds instead', async () => {
                const f = { 'tamper.js': 'export default "original";\n' };
                const { hash } = await storedOnly('tamperdb', f);
                const meta = { meta: { tenant_id: tenantId } };
                const [record] = await brokerA.call('serve.artifact.find', { query: { hash } }, meta);
                await fs.rm(path.join(dirA, hash), { recursive: true, force: true });
                const b = bucket();
                for (const file of await b.find({ filename: `${hash}/tamper.js` }).toArray()) await b.delete(file._id);
                await new Promise<void>((resolve, reject) => {
                    const up = b.openUploadStream(`${hash}/tamper.js`, { metadata: { hash, path: 'tamper.js' } });
                    up.once('finish', () => resolve()).once('error', reject);
                    up.end(Buffer.from('export default "changed";\n'));
                });

                // Stand-in for the build queue: completes the rebuild with the original content.
                const builder = setInterval(async () => {
                    const [pending] = await brokerA.call('serve.artifact.find', { query: { partId: record!.partId, status: 'pending' } }, meta);
                    if (pending === undefined) return;
                    await fs.mkdir(path.join(dirA, hash), { recursive: true });
                    await fs.writeFile(path.join(dirA, hash, 'tamper.js'), f['tamper.js']);
                    await brokerA.call('serve.artifact.update', { id: pending.id, status: 'success', hash, assets: record!.assets, builtOn: 'port-a', commit }, meta);
                }, 200);
                try {
                    expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, { nodeID: 'port-b', meta: { tenant_id: tenantId } }))
                        .toEqual({ artifactHash: hash, from: 'port-a' });
                    expect(await fs.readFile(path.join(dirB, hash, 'tamper.js'), 'utf8')).toBe(f['tamper.js']);
                } finally { clearInterval(builder); }
            }, 30000);
        });

        describe('lost everywhere: rebuilt from its commit', () => {
            const onB = (): { nodeID: string; meta: { tenant_id: string } } => ({ nodeID: 'port-b', meta: { tenant_id: tenantId } });
            /**
             * A build that exists only as a record: no disk has it, the database does not. And a
             * stand-in for the build queue, which this harness does not run: it completes the first
             * pending build of the part by writing `produce` to port-a's disk, as a builder would.
             */
            const lostBuild = async (name: string, original: Record<string, string>, produce: Record<string, string>) => {
                const partId = await newPart(name);
                const meta = { meta: { tenant_id: tenantId } };
                const { hashOutput } = await import('../src/catalog/methods/build.js');
                const toMap = (f: Record<string, string>) => new Map(Object.entries(f).map(([p, c]) => [p, Buffer.from(c)]));
                const lost = hashOutput(toMap(original));
                await brokerA.call('serve.artifact.create', {
                    tenantId, partId, ref: 'master', commit, status: 'success', hash: lost.hash, assets: lost.assets, builtOn: 'port-a',
                }, meta);
                const builder = setInterval(async () => {
                    const [pending] = await brokerA.call('serve.artifact.find', { query: { partId, status: 'pending' } }, meta);
                    if (pending === undefined) return;
                    const made = hashOutput(toMap(produce));
                    for (const [p, c] of Object.entries(produce)) {
                        await fs.mkdir(path.join(dirA, made.hash), { recursive: true });
                        await fs.writeFile(path.join(dirA, made.hash, p), c);
                    }
                    await brokerA.call('serve.artifact.update', { id: pending.id, status: 'success', hash: made.hash, assets: made.assets, builtOn: 'port-a', commit }, meta);
                }, 200);
                return { hash: lost.hash, stop: () => clearInterval(builder) };
            };

            it('rebuilds the same commit, checks the hash, and the node gets it', async () => {
                const f = { 'again.js': 'export default "built again";\n' };
                const { hash, stop } = await lostBuild('rebuilt', f, f);
                try {
                    expect(await brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB())).toEqual({ artifactHash: hash, from: 'port-a' });
                    expect(await fs.readFile(path.join(dirB, hash, 'again.js'), 'utf8')).toBe(f['again.js']);
                } finally { stop(); }
            }, 30000);

            it('refuses a rebuild that comes out different -- the build is not reproducible', async () => {
                const { hash, stop } = await lostBuild('drifted', { 'd.js': 'export default 1;\n' }, { 'd.js': 'export default 2;\n' });
                try {
                    await expect(brokerA.call('serve.artifact.pull', { artifactHash: hash }, onB())).rejects.toThrow(/not reproducible/);
                    await expect(fs.access(path.join(dirB, hash))).rejects.toThrow();
                } finally { stop(); }
            }, 30000);
        });

        it('refuses files that do not hash to what it claims', async () => {
            const partId = await newPart('tampered');
            const hash = await hashOf(files);
            await expect(brokerA.call('serve.artifact.importBuild', {
                partId, ref: 'master', commit, hash, files: asInput({ ...files, 'register.js': 'export default () => "changed";\n' }),
            }, { nodeID: 'port-a', meta: { tenant_id: tenantId } })).rejects.toThrow(/not the build it claims to be/);
        }, 20000);

        it('refuses a path that leaves the build\'s folder', async () => {
            const partId = await newPart('escape');
            const evil = { '../outside.js': 'x' };
            await expect(brokerA.call('serve.artifact.importBuild', {
                partId, ref: 'master', commit, hash: await hashOf(evil), files: asInput(evil),
            }, { nodeID: 'port-a', meta: { tenant_id: tenantId } })).rejects.toThrow(/not a path inside a build/);
            await expect(fs.access(path.join(dirA, 'outside.js'))).rejects.toThrow();
        }, 20000);
    });

    it('refuses cleanly when no node is recorded as having built it', async () => {
        const meta = { meta: { tenant_id: tenantId } };

        const repo = await brokerA.call('serve.repo.create', {
            tenantId, name: 'port-repo-2', url: '/tmp/nonexistent2.git', defaultBranch: 'master',
        }, meta);
        const part = await brokerA.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/orphan`, kind: 'service',
            path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta);

        const hash = 'test-portability-hash-orphan';
        // Deliberately not written to either node's disk, and no builtOn -- an artifact from before
        // this field existed, or one whose builder is simply unknown.
        await brokerA.call('serve.artifact.create', {
            tenantId, partId: part.id, ref: 'test', status: 'success',
            hash, assets: [{ url: 'entry.js', name: 'entry.js', fileExtension: '.js' }],
        }, meta);

        await expect(
            brokerA.call('serve.part.start', { id: part.id }, { nodeID: 'port-b', meta: meta.meta }),
        ).rejects.toThrow(/no local copy .* no other node is recorded/i);
    }, 20000);
});
