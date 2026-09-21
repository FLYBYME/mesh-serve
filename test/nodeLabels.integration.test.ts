/**
 * Labels a node advertises at start (`mesh-serve start --labels role=dns ...`), and what they're
 * for: `serve.node.find` lets an operator see what's online before pinning something to it, and
 * `serve.part`'s own `nodeSelector` field lets `serve.part.reconcile` place a service on an exact
 * node or a label match instead of wherever `placementFor`'s hash would otherwise land it --
 * necessary the moment physical constraints matter (DNS on the box with the right PTR record, mail
 * on the box with the established sending IP), which a deterministic-but-arbitrary hash cannot
 * respect.
 *
 * Two real nodes with different labels, exactly like supervisor.integration.test.ts's own two-node
 * shape -- pinning is not a thing one node can demonstrate either.
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
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';

const DB_NAME = 'mesh-serve-node-labels-integration-test';
const A_WS = 16580;
const B_WS = 16581;
const ORG_SLUG = 'labels-org';

async function bootNode(nodeID: string, ws: number, metadata: Record<string, string>, bootstrapNode?: string): Promise<MeshApp> {
    const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
    const app = new MeshApp({ nodeID, logger: new Logger(LogLevel.ERROR) });
    app.use(new RegistryModule({ implementation: PlacementRegistry, metadata }));
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

describe('node labels and pinned placement', () => {
    let appA: MeshApp;
    let appB: MeshApp;
    let brokerA: IServiceBroker;
    let tenantId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        appA = await bootNode('lbl-a', A_WS, { role: 'edge' });
        brokerA = appA.getProvider<IServiceBroker>('broker');
        appB = await bootNode('lbl-b', B_WS, { role: 'dns', region: 'bhs' }, `ws://127.0.0.1:${A_WS}`);
        await appB.getProvider<IServiceBroker>('broker').loadDomain('identity', {}, { resolve: resolveHandler });
        await new Promise((r) => { setTimeout(r, 1500); });

        const owner = await brokerA.call('identity.user.create', {
            email: 'lbl@node.invalid', displayName: 'Lbl', passwordHash: 'x'.repeat(32), roles: [], provisional: false,
        });
        const org = await brokerA.call('identity.organization.create', { slug: ORG_SLUG, name: 'Labels', ownerId: owner.id });
        tenantId = org.id;
    }, 40000);

    afterAll(async () => {
        await appB?.stop();
        await appA?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    describe('serve.node.find', () => {
        it('lists every online node with the labels each advertised at start', async () => {
            const nodes = await brokerA.call('serve.node.find', {});
            const a = nodes.find((n) => n.nodeID === 'lbl-a');
            const b = nodes.find((n) => n.nodeID === 'lbl-b');

            expect(a?.labels).toEqual({ role: 'edge' });
            expect(b?.labels).toEqual({ role: 'dns', region: 'bhs' });
        });

        it('narrows to nodes matching a "key=value" label', async () => {
            const dns = await brokerA.call('serve.node.find', { label: 'role=dns' });
            expect(dns.map((n) => n.nodeID)).toEqual(['lbl-b']);

            const none = await brokerA.call('serve.node.find', { label: 'role=nonexistent' });
            expect(none).toEqual([]);
        });
    });

    describe('serve.part.reconcile with a declared nodeSelector', () => {
        const meta = (): { meta: { tenant_id: string } } => ({ meta: { tenant_id: tenantId } });

        it('resolves a label selector and attempts a real start on the matching node, not wherever placementFor would pick', async () => {
            const repo = await brokerA.call('serve.repo.create', {
                tenantId, name: 'lbl-repo', url: '/tmp/nonexistent.git', defaultBranch: 'master',
            }, meta());
            const part = await brokerA.call('serve.part.create', {
                tenantId, repoId: repo.id, key: `${ORG_SLUG}/pinned`, kind: 'service',
                path: '.', entryPoint: 'src/index.ts', wants: [], desired: 'running', nodeSelector: 'role=dns',
            }, meta());
            expect(part.nodeSelector).toBe('role=dns');

            const result = await brokerA.call('serve.part.reconcile', {});
            // No real build exists, so it fails the ordinary way startService already reports for
            // an unbuilt part -- proof the pin resolved to a real, matching node and reached the
            // normal start path, not that the selector itself failed to resolve.
            expect(result.failed).toHaveLength(1);
            expect(result.failed[0]?.key).toBe(`${ORG_SLUG}/pinned`);
            expect(result.failed[0]?.error).toMatch(/no successful build/i);
        }, 20000);

        it('pins by an exact nodeID too, not only a label', async () => {
            const repo = await brokerA.call('serve.repo.create', {
                tenantId, name: 'lbl-repo-2', url: '/tmp/nonexistent2.git', defaultBranch: 'master',
            }, meta());
            const part = await brokerA.call('serve.part.create', {
                tenantId, repoId: repo.id, key: `${ORG_SLUG}/pinned-by-id`, kind: 'service',
                path: '.', entryPoint: 'src/index.ts', wants: [], desired: 'running', nodeSelector: 'lbl-a',
            }, meta());

            const result = await brokerA.call('serve.part.reconcile', {});
            const mine = result.failed.find((f) => f.key === part.key);
            expect(mine?.error).toMatch(/no successful build/i);
        }, 20000);

        it('fails loudly, without falling back to automatic placement, when the selector matches nothing online', async () => {
            const repo = await brokerA.call('serve.repo.create', {
                tenantId, name: 'lbl-repo-3', url: '/tmp/nonexistent3.git', defaultBranch: 'master',
            }, meta());
            const part = await brokerA.call('serve.part.create', {
                tenantId, repoId: repo.id, key: `${ORG_SLUG}/unmatched`, kind: 'service',
                path: '.', entryPoint: 'src/index.ts', wants: [], desired: 'running', nodeSelector: 'role=mail',
            }, meta());

            const result = await brokerA.call('serve.part.reconcile', {});
            const mine = result.failed.find((f) => f.key === part.key);
            expect(mine?.error).toMatch(/no online node matches nodeSelector "role=mail"/i);
        }, 20000);
    });
});
