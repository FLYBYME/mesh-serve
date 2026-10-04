/**
 * A service part runs the build it is pinned to (`serve.part.artifactId`), not whatever built last.
 *
 * Before this, serve.part.start always loaded the newest successful artifact, so requesting a build
 * -- of any ref, even a test branch -- silently decided what the next restart would run, nothing
 * said which build a running service actually was, and rolling back meant rebuilding the old ref.
 *
 * A real start cannot complete under vitest (ensureArtifactNodeModules needs import.meta.resolve;
 * see artifactPortability.integration.test.ts), so which artifact start *chose* is read from the
 * error it gives for an artifact with no local files: that message names the artifact's hash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import { clearServiceRunning, getRunningService, markServiceRunning } from '../src/catalog/methods/services.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-artifact-pin-integration-test';
const WS = 16590; // 16591 is nodeMesh's: two files on one port fail each other in a parallel run
const NODE = 'pin-a';
const ORG_SLUG = 'pin-org';

describe('serve.part.artifactId: which build a service runs', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let tenantId = '';

    const meta = (): { meta: { tenant_id: string } } => ({ meta: { tenant_id: tenantId } });

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: NODE, logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });

        const owner = await broker.call('identity.user.create', {
            email: 'pin@node.invalid', displayName: 'Pin', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        const org = await broker.call('identity.organization.create', { slug: ORG_SLUG, name: 'Pin', ownerId: owner.id });
        tenantId = org.id;
    }, 40000);

    afterAll(async () => {
        await app?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    let partCounter = 0;
    async function newPart(): Promise<string> {
        partCounter++;
        const repo = await broker.call('serve.repo.create', {
            tenantId, name: `pin-repo-${partCounter}`, url: `/tmp/nonexistent-${partCounter}.git`, defaultBranch: 'master',
        }, meta());
        const part = await broker.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/svc-${partCounter}`, kind: 'service',
            path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta());
        return part.id;
    }

    /** A build record with no files on disk anywhere and no builtOn -- start refuses it naming its hash. */
    async function build(partId: string, hash: string, status: 'success' | 'failed' = 'success'): Promise<string> {
        const artifact = await broker.call('serve.artifact.create', {
            tenantId, partId, ref: 'master', status,
            ...(status === 'success'
                ? { hash, assets: [{ url: 'entry.js', name: 'entry.js', fileExtension: '.js' }] }
                : { error: 'tsc exploded' }),
        }, meta());
        return artifact.id;
    }

    async function hashStartChose(partId: string): Promise<string | undefined> {
        const err = await broker.call('serve.part.start', { id: partId }, meta()).then(() => undefined, (e: unknown) => e);
        const message = err instanceof Error ? err.message : String(err);
        return /Artifact (\S+) has no local copy/.exec(message)?.[1];
    }

    it('with no pin, still runs the newest successful build (parts from before pinning keep working)', async () => {
        const partId = await newPart();
        await build(partId, 'hash-older');
        await new Promise((r) => { setTimeout(r, 20); });
        await build(partId, 'hash-newer');

        expect(await hashStartChose(partId)).toBe('hash-newer');
    });

    it('with a pin, runs exactly the pinned build even when a newer one exists', async () => {
        const partId = await newPart();
        const older = await build(partId, 'pinned-older');
        await new Promise((r) => { setTimeout(r, 20); });
        await build(partId, 'pinned-newer');

        await broker.call('serve.part.update', { id: partId, artifactId: older }, meta());

        expect(await hashStartChose(partId)).toBe('pinned-older');
    });

    it("refuses to pin another part's build", async () => {
        const mine = await newPart();
        const theirs = await newPart();
        const theirBuild = await build(theirs, 'theirs');

        await expect(broker.call('serve.part.update', { id: mine, artifactId: theirBuild }, meta()))
            .rejects.toThrow(/is a build of part/);
    });

    it('refuses to pin a build that did not succeed', async () => {
        const partId = await newPart();
        const failed = await build(partId, 'unused', 'failed');

        await expect(broker.call('serve.part.update', { id: partId, artifactId: failed }, meta()))
            .rejects.toThrow(/not a successful build: tsc exploded/);
    });

    it('refuses to pin an artifact that does not exist', async () => {
        const partId = await newPart();
        await expect(broker.call('serve.part.update', { id: partId, artifactId: 'no-such-artifact' }, meta()))
            .rejects.toThrow(/No artifact "no-such-artifact"/);
    });

    it('refuses an artifactId on create, since no build of a part can exist before the part does', async () => {
        const repo = await broker.call('serve.repo.create', {
            tenantId, name: 'pin-repo-create', url: '/tmp/nonexistent-create.git', defaultBranch: 'master',
        }, meta());
        await expect(broker.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/born-pinned`, kind: 'service',
            path: '.', entryPoint: 'src/index.ts', wants: [], artifactId: 'anything',
        }, meta())).rejects.toThrow(/cannot be created with an artifactId/);
    });

    it('reports which artifact each running service actually loaded', async () => {
        const partId = await newPart();
        markServiceRunning(NODE, partId, 'svc.domain', '/tmp/svc.cjs', 'artifact-loaded');
        try {
            const report = await broker.call('serve.part.runningHere', {}, { nodeID: NODE });
            expect(report.services.find((s) => s.partId === partId)?.artifactId).toBe('artifact-loaded');
        } finally {
            clearServiceRunning(NODE, partId);
        }
    });

    it('reconcile leaves a service alone while it runs its pinned build', async () => {
        const partId = await newPart();
        const pinned = await build(partId, 'current');
        await broker.call('serve.part.update', { id: partId, artifactId: pinned, desired: 'running' }, meta());
        markServiceRunning(NODE, partId, 'svc.domain', '/tmp/svc.cjs', pinned);
        try {
            const result = await broker.call('serve.part.reconcile', {});
            const touched = [...result.started, ...result.stopped, ...result.redeployed, ...result.failed].map((r) => r.partId);
            expect(touched).not.toContain(partId);
        } finally {
            clearServiceRunning(NODE, partId);
            await broker.call('serve.part.update', { id: partId, desired: 'stopped' }, meta());
        }
    }, 20000);

    it('reconcile acts on a pin that moved -- and never stops the old build before the new one is there', async () => {
        const partId = await newPart();
        const oldBuild = await build(partId, 'a'.repeat(64));
        // A build no node, no database copy and no rebuild can produce (no commit recorded).
        const newBuild = await build(partId, 'b'.repeat(64));
        await broker.call('serve.part.update', { id: partId, artifactId: newBuild, desired: 'running' }, meta());
        // Running the old build, as it would be right after the pin was changed.
        markServiceRunning(NODE, partId, 'svc.domain', '/tmp/svc.cjs', oldBuild);
        try {
            const result = await broker.call('serve.part.reconcile', {});
            // Reconcile saw the drift and acted on it -- and since the new build cannot be had,
            // it says so and leaves the old one running instead of stopping it into an outage.
            const failure = result.failed.find((f) => f.partId === partId);
            expect(failure?.error ?? '').toMatch(/new build is not available.*the old build keeps running/);
            expect(result.redeployed.find((r) => r.partId === partId)).toBeUndefined();
            expect(getRunningService(NODE, partId)?.artifactId).toBe(oldBuild);
        } finally {
            clearServiceRunning(NODE, partId);
            await broker.call('serve.part.update', { id: partId, desired: 'stopped' }, meta());
        }
    }, 20000);

    it('requestBuild sets pinOnSuccess from pin input', async () => {
        const partId = await newPart();
        const unpinned = await broker.call('serve.artifact.requestBuild', {
            partId, ref: 'master',
        }, meta());
        expect(unpinned.pinOnSuccess).toBeFalsy();

        const pinned = await broker.call('serve.artifact.requestBuild', {
            partId, ref: 'master', pin: true,
        }, meta());
        expect(pinned.pinOnSuccess).toBe(true);

        const explicitFalse = await broker.call('serve.artifact.requestBuild', {
            partId, ref: 'master', pin: false,
        }, meta());
        expect(explicitFalse.pinOnSuccess).toBe(false);
    });
});
