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
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
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
