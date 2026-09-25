/**
 * Two nodes, one of which serves traffic for a domain it does not hold.
 *
 * Every bug found in the last stretch lived in exactly this shape and was invisible to every
 * single-node test:
 *
 * - a registry `ttl` below the presence interval, so peers spent most of each cycle marked offline
 * - the api gateway needing a contract's *declaration* to route to an implementation elsewhere,
 *   answering 404 on one node and 200 on another for identical expose rows
 * - a MeshError's status lost crossing the mesh, so the same call was 404 locally and 500 remotely
 *
 * None of them threw anything. Each looked like a different, ordinary failure. So this test asserts
 * the property that ties them together: **node B must answer exactly as node A does**, for a domain
 * only node A implements.
 *
 * Parts load from the precompiled `.cjs` bundles rather than from source, deliberately -- that is
 * the path a real node uses, and `require()`ing them is what creates the second module realm where
 * `instanceof` stops working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
    defaultPrint, defineContract, z,
} from '@flybyme/mesh';

/** Takes 11 s and says it may take 15: past the broker's 10 s default, inside its own declaration. */
const slowContract = defineContract({
    domain: 'slowsvc', action: 'wait', description: 'Takes 11 seconds.',
    inputSchema: z.object({}), outputSchema: z.object({ waited: z.boolean() }),
    rest: { method: 'POST', path: '/slowsvc/wait' }, visibility: 'public', destructive: false,
    filePath: 'test/twoNode.integration.test.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: defaultPrint, timeout: 15_000,
});
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';
import '../src/catalog/contracts/corePart.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-two-node-integration-test';
const A = { ws: 16563, api: 15563, cdn: 13563 };
const B = { ws: 16564, api: 15564, cdn: 13564 };
const PASSWORD = 'a-real-operator-password-12';

async function json(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
}

/**
 * Boots a node *and* loads its parts before the next one starts.
 *
 * The order matters, and finding out why is worth recording: a gateway reads its port from
 * `process.env.API_PORT` when its listen contract runs, because `loadDomain` calls a long-running
 * contract with no params. That is fine for a real deployment -- one node per process -- but in
 * one process the env is shared, so booting both nodes and *then* loading their parts makes both
 * read whichever port was set last, and the second bind fails with EADDRINUSE.
 */
async function bootNode(nodeID: string, ports: typeof A, parts: readonly ('identity' | 'api')[], bootstrapNode?: string): Promise<MeshApp> {
    const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
    process.env.API_PORT = String(ports.api);
    process.env.SERVER_PORT = String(ports.cdn);

    const app = new MeshApp({ nodeID, logger: new Logger(LogLevel.ERROR) });
    app.use(new RegistryModule({ implementation: PlacementRegistry }));
    app.use(new NetworkModule({
        transports: [new WSTransport(new JSONSerializer(), ports.ws, '127.0.0.1')],
        ...(bootstrapNode !== undefined ? { bootstrapNodes: [bootstrapNode] } : {}),
    }));
    app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
    app.use(new BrokerModule());
    await app.start();

    // Exactly what start.ts does: the catalog kernel, then whatever --parts names.
    const broker = app.getProvider<IServiceBroker>('broker');
    for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
    for (const name of parts) await broker.call('serve.corePart.load', { name }, { nodeID });
    return app;
}

describe('two nodes, one serving a domain it does not hold', () => {
    let appA: MeshApp;
    let appB: MeshApp;
    let brokerA: IServiceBroker;
    let brokerB: IServiceBroker;
    let token = '';

    const originA = `http://api.localhost:${A.api}`;
    const originB = `http://api.localhost:${B.api}`;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        // A runs identity and an api. B runs only an api -- it holds no identity contracts at all.
        appA = await bootNode('two-node-a', A, ['identity', 'api']);
        brokerA = appA.getProvider<IServiceBroker>('broker');
        // Only A runs it; B learns its declaration from A's presence, as edge1 does surf's.
        brokerA.registerContract(slowContract, async () => {
            await new Promise((resolve) => setTimeout(resolve, 11_000));
            return { waited: true };
        });

        appB = await bootNode('two-node-b', B, ['api'], `ws://127.0.0.1:${A.ws}`);
        brokerB = appB.getProvider<IServiceBroker>('broker');

        await new Promise((r) => { setTimeout(r, 1200); });

        await brokerA.call('identity.role.ensureBuiltins', {});
        const operator = await brokerA.call('identity.user.create', {
            email: 'op@two.invalid', displayName: 'Op', passwordHash: await hashPassword(PASSWORD),
            roles: ['operator'], provisional: false,
        });
        // No manual membership.create after this: identity.organization.create's own `after`
        // hook now creates the owner's membership itself.
        const org = await brokerA.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator.id });
        await ensureBootstrapApi(brokerA);

        const api = await brokerA.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api missing');
        const meta = { meta: { tenant_id: org.id } };
        for (const contract of ['identity.user.grantRole', 'slowsvc.wait']) {
            const existing = await brokerA.call('serve.expose.find_one', { query: { apiId: api.id, contract } }, meta);
            if (existing === undefined) await brokerA.call('serve.expose.add', { apiId: api.id, contract }, meta);
        }

        const ticket = await json(await fetch(`${originA}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'op@two.invalid', password: PASSWORD }),
        })) as { token: string };
        token = ticket.token;
    }, 60000);

    afterAll(async () => {
        await appB?.stop();
        await appA?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('sees each other, and keeps seeing each other', async () => {
        // A ttl below the presence interval made peers flap between offline and online without
        // anything erroring. Checked after a delay rather than immediately, because the broken
        // version connected fine and only came apart seconds later.
        await new Promise((r) => { setTimeout(r, 1500); });
        const registryB = appB.getProvider<{ getNodes: () => { nodeID: string; available?: boolean }[] }>('registry');
        const a = registryB.getNodes().find((n) => n.nodeID === 'two-node-a');
        expect(a).toBeDefined();
        expect(a?.available).not.toBe(false);
    }, 15000);

    it('node B holds no identity contracts of its own', () => {
        const mounted = brokerB.listContracts().map((c) => `${c.domain}.${c.action}`);
        expect(mounted.some((k) => k.startsWith('identity.'))).toBe(false);
        expect(mounted).toContain('serve.api.describe');
    });

    it('answers an identity call through node B, routed to node A', async () => {
        const res = await fetch(`${originB}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'op@two.invalid', password: PASSWORD }),
        });
        expect(res.status).toBe(200);
        expect(typeof (await json(res)).token).toBe('string');
    });

    it('accepts through A a ticket issued through B', async () => {
        const issued = await json(await fetch(`${originB}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'op@two.invalid', password: PASSWORD }),
        })) as { token: string };

        const res = await fetch(`${originA}/api/identity/whoami`, {
            headers: { authorization: `Bearer ${issued.token}` },
        });
        expect(res.status).toBe(200);
    });

    it('gives the same status for the same error on both nodes', async () => {
        // The regression that matters most: identity runs only on A, so this error is local there
        // and remote here. It was 404 on A and 500 on B -- the status lost crossing the mesh, then
        // lost again to an instanceof check across module realms.
        const body = JSON.stringify({ userId: 'nobody-at-all', role: 'admin', granted: true });
        const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

        const onA = await fetch(`${originA}/api/identity/roles`, { method: 'POST', headers, body });
        const onB = await fetch(`${originB}/api/identity/roles`, { method: 'POST', headers, body });

        expect(onA.status).toBe(404);
        expect(onB.status).toBe(onA.status);
        expect((await json(onB)).error).toBe((await json(onA)).error);
    });

    /**
     * machine.import (declared 30 minutes, running on surf) answered 500 through edge1's api after
     * 10 s -- the broker's default -- while the import carried on. The contract's timeout now
     * travels with its declaration and the gateway calls with it.
     *
     * Limit: both nodes share one process here, and mesh keeps local contract timeouts in a
     * process-wide registry, so B's broker would find A's timeout even without the gateway passing
     * it. The declaration assertion is the part this test proves (it fails on mesh v4.6.0); the
     * gateway half was verified live, through edge1's api to surf.
     */
    it('lets a call to another node run as long as its contract declares', async () => {
        expect(brokerB.contractDeclaration('slowsvc.wait')?.timeout).toBe(15_000);
        const res = await fetch(`${originB}/api/slowsvc/wait`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
        });
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({ waited: true });
    }, 30_000);

    it('applies the contract permission floor on the node that does not implement it', async () => {
        // The expose row names no role. The floor comes from the contract, which node B knows the
        // declaration of without running the implementation.
        const res = await fetch(`${originB}/api/identity/roles`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: 'x', role: 'operator', granted: true }),
        });
        expect(res.status).toBe(401);
    });

    it('describes the same exposure from both nodes', async () => {
        const a = await json(await fetch(`${originA}/api/_describe`)) as { calls: unknown[]; exposure: string };
        const b = await json(await fetch(`${originB}/api/_describe`)) as { calls: unknown[]; exposure: string };

        expect(b.calls.length).toBe(a.calls.length);
        expect(b.exposure).toBe(a.exposure);
    });
});
