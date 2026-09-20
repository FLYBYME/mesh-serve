/**
 * The supervisor: a service that should be running gets started, and stays running when the node
 * holding it goes away.
 *
 * `serve.part.start` is imperative -- it runs a service on the node the call reaches, once.
 * Nothing recorded that it *should* still be running, so a node dying simply took the service with
 * it and nothing noticed. These tests are the gap closing: desired state on the part row, observed
 * state asked of each node directly, and a leaderScoped interval that reconciles the two.
 *
 * Two nodes, because failover is not a thing one node can demonstrate.
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
import { markServiceRunning, clearServiceRunning } from '../src/catalog/methods/services.js';
// serve.part's own create hook validates that the key is namespaced by a real organization's slug,
// so identity has to be here -- see catalog/methods/partKey.ts.
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-supervisor-integration-test';
const A_WS = 16568;
const B_WS = 16569;
const ORG_SLUG = 'supervisor-org';

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

describe('desired state, observed state, and the loop between them', () => {
    let appA: MeshApp;
    let appB: MeshApp;
    let brokerA: IServiceBroker;
    let brokerB: IServiceBroker;
    let partId = '';
    let tenantId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        appA = await bootNode('sup-a', A_WS);
        brokerA = appA.getProvider<IServiceBroker>('broker');
        appB = await bootNode('sup-b', B_WS, `ws://127.0.0.1:${A_WS}`);
        brokerB = appB.getProvider<IServiceBroker>('broker');
        await brokerA.loadDomain('identity', {}, { resolve: resolveHandler });
        await new Promise((r) => { setTimeout(r, 1500); });

        const owner = await brokerA.call('identity.user.create', {
            email: 'sup@node.invalid', displayName: 'Sup', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        const org = await brokerA.call('identity.organization.create', { slug: ORG_SLUG, name: 'Supervisor', ownerId: owner.id });
        tenantId = org.id;

        const meta = { meta: { tenant_id: tenantId } };
        const repo = await brokerA.call('serve.repo.create', {
            tenantId, name: 'sup-repo', url: '/tmp/nonexistent.git', defaultBranch: 'master',
        }, meta);
        const part = await brokerA.call('serve.part.create', {
            tenantId, repoId: repo.id, key: `${ORG_SLUG}/worker`, kind: 'service',
            path: '.', entryPoint: 'src/index.ts', wants: [],
        }, meta);
        partId = part.id;
    }, 40000);

    afterAll(async () => {
        await appB?.stop();
        await appA?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    const meta = (): { meta: { tenant_id: string } } => ({ meta: { tenant_id: tenantId } });

    it('defaults a new service to stopped -- nothing starts by existing', async () => {
        const part = await brokerA.call('serve.part.get', { id: partId }, meta());
        expect(part.desired).toBe('stopped');
    });

    it('does nothing at all while nothing is desired', async () => {
        const result = await brokerA.call('serve.part.reconcile', {});
        expect(result.started).toEqual([]);
        expect(result.stopped).toEqual([]);
        expect(result.failed).toEqual([]);
    });

    it('reports a failure rather than throwing when a desired service cannot start', async () => {
        // This part has no successful build, so serve.part.start refuses it. The pass must still
        // complete: one unbuildable part cannot be allowed to stall every other service.
        await brokerA.call('serve.part.update', { id: partId, desired: 'running' }, meta());

        const result = await brokerA.call('serve.part.reconcile', {});
        expect(result.started).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.key).toBe(`${ORG_SLUG}/worker`);
        expect(result.failed[0]?.error).toMatch(/no successful build/i);
    }, 20000);

    it('asks each node what it is running, and each answers for itself', async () => {
        const onA = await brokerA.call('serve.part.runningHere', {}, { nodeID: 'sup-a' });
        const onB = await brokerA.call('serve.part.runningHere', {}, { nodeID: 'sup-b' });

        expect(onA.nodeID).toBe('sup-a');
        expect(onB.nodeID).toBe('sup-b');
        expect(onA.services).toEqual([]);
        expect(onB.services).toEqual([]);
    });

    it('sees a service as running once a node reports it, and leaves it alone', async () => {
        // Stand in for a real start: mark it running on B exactly as startService would. The
        // supervisor's input is what nodes *report*, so this is the honest seam to inject at --
        // building and loading a real service part is covered by the catalog tests.
        markServiceRunning('sup-b', partId, 'worker.domain', '/tmp/worker.cjs');
        try {
            const onB = await brokerA.call('serve.part.runningHere', {}, { nodeID: 'sup-b' });
            expect(onB.services.map((s) => s.partId)).toContain(partId);

            // Desired running, observed running: nothing to do, and specifically no second copy.
            const result = await brokerA.call('serve.part.reconcile', {});
            expect(result.started).toEqual([]);
            expect(result.failed).toEqual([]);
        } finally {
            clearServiceRunning('sup-b', partId);
        }
    }, 20000);

    it('notices when the node holding it stops reporting it', async () => {
        // The failover signal, and the reason observed state is asked rather than stored: B no
        // longer claims the service, so the very next pass treats it as missing and tries to place
        // it again. A database flag would have survived the crash that made it wrong.
        const result = await brokerA.call('serve.part.reconcile', {});
        expect(result.started).toEqual([]);      // still unbuildable
        expect(result.failed).toHaveLength(1);   // but it *tried*, which is the point
    }, 20000);

    it('stops a service that is running but no longer desired', async () => {
        await brokerA.call('serve.part.update', { id: partId, desired: 'stopped' }, meta());
        markServiceRunning('sup-b', partId, 'worker.domain', '/tmp/worker.cjs');

        try {
            const result = await brokerA.call('serve.part.reconcile', {});
            // serve.part.stop runs on B and fails (nothing was really loaded), but the supervisor
            // identified the right part on the right node, which is what is under test here.
            const touched = [...result.stopped, ...result.failed].map((r) => r.partId);
            expect(touched).toContain(partId);
        } finally {
            clearServiceRunning('sup-b', partId);
        }
    }, 20000);

    it('is leaderScoped, so two nodes cannot both place the same service', async () => {
        // Without this, both nodes would see the service as missing and both start it. The guard
        // is in the interval timer (ServiceBroker.startIntervalContract); asserting the contract
        // declares it is what keeps that guarantee from being removed by accident.
        const contract = brokerA.listContracts().find((c) => c.domain === 'serve.part' && c.action === 'reconcile');
        expect(contract?.leaderScoped).toBe(true);
        expect(contract?.concurrency).toBe('interval');

        // And both nodes agree who that leader is.
        const registryA = appA.getProvider<{ leaderFor: (d: string) => { nodeID: string } | undefined }>('registry');
        const registryB = appB.getProvider<{ leaderFor: (d: string) => { nodeID: string } | undefined }>('registry');
        expect(registryA.leaderFor('serve.part')?.nodeID).toBe(registryB.leaderFor('serve.part')?.nodeID);
    });
});
