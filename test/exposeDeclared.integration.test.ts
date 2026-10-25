/**
 * An api that says `exposeDeclared` serves every public contract whose own `permissions` gate it,
 * with no serve.expose row (owner, 10-11: api.surfdns.net carried 612 rows by hand). Over real HTTP:
 * the platform's api (made by ensureBootstrapApi, which sets it) and a second api that does not.
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
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';
import '../src/catalog/contracts/corePart.contract.js';
import '../src/catalog/contracts/node.contract.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';
import '../src/api/contracts/api.contract.js';
import '../src/api/contracts/expose.contract.js';
import '../src/api/contracts/want.contract.js';
import '../src/api/contracts/generateClient.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-expose-declared-integration-test';
const WS_PORT = 16573;
const API_PORT = 15573;
const PLATFORM = `http://api.localhost:${API_PORT}`;
const CUSTOMER = `http://customer.localhost:${API_PORT}`;
const MEMBERS = `http://members.localhost:${API_PORT}`;
const PASSWORD = 'a-real-password-for-tests-12';

describe('the platform api exposes what a contract gates, without a row', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const token: Record<string, string> = {};

    const get = async (origin: string, path: string, who?: string): Promise<number> => {
        const res = await fetch(`${origin}${path}`, { headers: who !== undefined ? { authorization: `Bearer ${token[who]}` } : {} });
        await res.body?.cancel();

        return res.status;
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'expose-declared-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.api', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.expose', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.activity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        const user = async (key: string, roles: string[]): Promise<string> => (await broker.call('identity.user.create', {
            email: `${key}@declared.invalid`, displayName: key, passwordHash: await hashPassword(PASSWORD), roles, provisional: false,
        })).id;
        const operator = await user('operator', ['operator']);
        const ada = await user('ada', []);

        const platform = await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator });
        await broker.call('identity.organization.create', { slug: 'peera', name: 'Peera', ownerId: ada });

        await ensureBootstrapApi(broker);
        await broker.call('serve.api.create', { tenantId: platform.id, apiHost: 'customer.localhost' }, { meta: { tenant_id: platform.id } });
        await broker.call('serve.api.create', {
            tenantId: platform.id, apiHost: 'members.localhost', exposeDeclared: true, exposeRoles: ['member'],
        }, { meta: { tenant_id: platform.id } });

        for (const who of ['operator', 'ada']) {
            const res = await fetch(`${PLATFORM}/api/identity/ticket`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: `${who}@declared.invalid`, password: PASSWORD }),
            });
            token[who] = (await res.json() as { token: string }).token;
        }
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    // serve.node.find: public, permissions ['operator'], and no bootstrap row names it.
    it('serves a contract gated to operators to an operator, with no row', async () => {
        expect(await get(PLATFORM, '/api/nodes', 'operator')).toBe(200);
    });

    it('holds the contract\'s gate: a member is refused, and nobody signed in must sign in', async () => {
        expect(await get(PLATFORM, '/api/nodes', 'ada')).toBe(403);
        expect(await get(PLATFORM, '/api/nodes')).toBe(401);
    });

    it('routes a call without making any contract\'s declaration again (owner\'s profile, 10-16: ~740 per request)', async () => {
        // Warm: the target, its route table and its descriptor are made.
        expect(await get(PLATFORM, '/api/nodes', 'operator')).toBe(200);

        const original = broker.contractDeclaration.bind(broker);
        let asked = 0;
        broker.contractDeclaration = (key) => {
            asked++;
            return original(key);
        };
        try {
            for (let i = 0; i < 20; i++) expect(await get(PLATFORM, '/api/nodes', 'operator')).toBe(200);
        } finally {
            broker.contractDeclaration = original;
        }

        // One per call is mesh's own callNamed checking the contract it runs (one schema, not ~740).
        expect(asked).toBeLessThanOrEqual(20);
    });

    it('describes it, with the contract\'s gate', async () => {
        const res = await fetch(`${PLATFORM}/api/_describe`);
        const described = await res.json() as { calls: { key: string; gate: string }[] };

        expect(described.calls.find((call) => call.key === 'serve.node.find')?.gate).toBe('operator');
    });

    // serve.release.find is public with permissions [], and no bootstrap row names it: making it
    // reachable stays a written-down row.
    it('does not expose a contract that declares no gate', async () => {
        expect(await get(PLATFORM, '/api/releases', 'operator')).toBe(404);
    });

    // serve.part's events take its read gate, ['operator']; serve.release's declare none.
    const stream = async (origin: string, events: string, who?: string): Promise<number> => {
        const controller = new AbortController();
        const res = await fetch(`${origin}/api/events?events=${events}`, {
            headers: who !== undefined ? { authorization: `Bearer ${token[who]}` } : {},
            signal: controller.signal,
        });
        controller.abort();

        return res.status;
    };

    it('streams an event its definition gates, with no row, to who holds the gate', async () => {
        expect(await stream(PLATFORM, 'serve.part.updated', 'operator')).toBe(200);
        expect(await stream(PLATFORM, 'serve.part.updated', 'ada')).toBe(403);
        expect(await stream(PLATFORM, 'serve.part.updated')).toBe(401);
    });

    it('does not stream an event whose definition declares no gate', async () => {
        expect(await stream(PLATFORM, 'serve.release.created', 'operator')).toBe(403);
    });

    it('describes a streamed event with its definition\'s gate', async () => {
        const res = await fetch(`${PLATFORM}/api/_describe`);
        const described = await res.json() as { events: { name: string; gate?: { role: string } }[] };

        expect(described.events.find((event) => event.name === 'serve.part.updated')?.gate?.role).toBe('operator');
    });

    it('on an api limited to members, serves a member\'s call and not an operator\'s, nor its name', async () => {
        expect(await get(MEMBERS, '/api/activity/mine', 'ada')).toBe(200);
        expect(await get(MEMBERS, '/api/nodes', 'operator')).toBe(404);
        // 404 here: no member event is streamed on this test's api at all; with one, 403.
        expect(await stream(MEMBERS, 'serve.part.updated', 'operator')).not.toBe(200);

        const res = await fetch(`${MEMBERS}/api/_describe`);
        const described = await res.json() as { calls: { key: string }[]; events: { name: string }[] };

        expect(described.calls.map((call) => call.key)).toContain('serve.activity.mine');
        expect(described.calls.map((call) => call.key)).not.toContain('serve.node.find');
        expect(described.events.map((event) => event.name)).not.toContain('serve.part.updated');
    });

    it('serve.api.describe lists the calls /api/_describe does, the declared ones too (10-25)', async () => {
        const served = await (await fetch(`${PLATFORM}/api/_describe`)).json() as { calls: { key: string }[] };
        const described = await broker.call('serve.api.describe', { host: 'api.localhost' });

        expect(described.calls.map((call) => call.key).sort()).toEqual(served.calls.map((call) => call.key).sort());
        expect(described.calls.find((call) => call.key === 'serve.node.find')?.gate).toBe('operator');
    });

    it('exposes nothing this way on an api that does not say exposeDeclared', async () => {
        expect(await stream(CUSTOMER, 'serve.part.updated', 'operator')).toBe(404);
        expect(await get(CUSTOMER, '/api/nodes', 'operator')).toBe(404);
    });
});
