/**
 * The contract permission floor, over real HTTP.
 *
 * The api's gate used to be entirely extrinsic: a `serve.expose` row with no `role` is anonymous.
 * That fails open -- publishing a destructive contract without a role made it reachable by anybody,
 * and nothing anywhere said that was a mistake. `identity.user.grantRole` is the sharpest example:
 * it grants any role to any account and has no check of its own, so the only thing between it and
 * an anonymous caller was that nobody had written that row yet.
 *
 * A contract's own `permissions` is now a floor the row cannot lower. These tests deliberately
 * expose gated contracts with *no* role, which is exactly the mistake the floor exists to survive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { Database, IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';
import '../src/catalog/contracts/corePart.contract.js';
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

const DB_NAME = 'mesh-serve-permissions-integration-test';
const WS_PORT = 16561;
const API_PORT = 15561;
const ORIGIN = `http://api.localhost:${API_PORT}`;
const PASSWORD = 'a-real-operator-password-12';

async function json(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
}

describe('a contract permission floor an expose row cannot lower', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let operatorToken = '';
    let memberToken = '';
    let apiId = '';
    let memberUserId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'permissions-node', logger: new Logger(LogLevel.ERROR) });
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

        await broker.call('identity.role.ensureBuiltins', {});

        const operator = await broker.call('identity.user.create', {
            email: 'op@perm.invalid', displayName: 'Op', passwordHash: await hashPassword(PASSWORD),
            roles: ['operator'], provisional: false,
        });
        // No manual membership.create after this: identity.organization.create's own `after`
        // hook now creates the owner's membership itself.
        const org = await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator.id });
        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        apiId = api.id;

        // An ordinary account with no operator role.
        const member = await broker.call('identity.user.create', {
            email: 'member@perm.invalid', displayName: 'Member', passwordHash: await hashPassword(PASSWORD),
            roles: [], provisional: false,
        });
        memberUserId = member.id;
        await broker.call('identity.membership.create', {
            userId: member.id, organizationId: org.id, roleKey: 'member', joinedAt: new Date(),
        }, { meta: { user: { id: member.id, tenant_id: '', organizationId: org.id } } });

        const meta = { meta: { tenant_id: org.id } };
        // Deliberately no `role` on any of these rows -- the mistake the floor exists to survive.
        for (const contract of ['identity.user.grantRole', 'identity.role.upsert', 'identity.whoami', 'identity.ticket.issue']) {
            const existing = await broker.call('serve.expose.find_one', { query: { apiId, contract } }, meta);
            // public: true -- deliberately ungated rows, the mistake the floor exists to survive.
            if (existing === undefined) await broker.call('serve.expose.add', { apiId, contract, public: true }, meta);
        }

        for (const [email, target] of [['op@perm.invalid', 'operator'], ['member@perm.invalid', 'member']] as const) {
            const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email, password: PASSWORD }),
            });
            const ticket = await json(res) as { token: string };
            if (target === 'operator') operatorToken = ticket.token; else memberToken = ticket.token;
        }
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    const grantBody = JSON.stringify({ userId: 'anyone', role: 'operator', granted: true });

    it('refuses an anonymous caller even though the row names no role', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/roles`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: grantBody,
        });
        expect(res.status).toBe(401);
    });

    it('refuses an authenticated caller who lacks the declared role', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/roles`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${memberToken}` },
            body: grantBody,
        });
        expect(res.status).toBe(403);
        expect(String((await json(res)).error)).toMatch(/requires role "operator"/);
    });

    it('allows a caller who holds it', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/roles`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ userId: memberUserId, role: 'admin', granted: true }),
        });
        expect(res.status).toBe(200);
    });

    it('leaves a contract that declares no floor genuinely public', async () => {
        // identity.ticket.issue is how you log in; it must stay reachable with no credentials.
        const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'member@perm.invalid', password: PASSWORD }),
        });
        expect(res.status).toBe(200);
    });

    it('still requires nothing extra of an ungated contract for a signed-in caller', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/whoami`, {
            headers: { authorization: `Bearer ${memberToken}` },
        });
        expect(res.status).toBe(200);
    });

    it('reports the floor in the descriptor, so a client can tell before calling', async () => {
        const res = await fetch(`${ORIGIN}/api/_describe`);
        const descriptor = await json(res) as { calls: { key: string; gate: string }[] };

        const gateOf = (key: string): string | undefined => descriptor.calls.find((c) => c.key === key)?.gate;
        expect(gateOf('identity.user.grantRole')).toBe('operator');
        expect(gateOf('identity.role.upsert')).toBe('operator');
        // Genuinely ungated, and now distinguishable from "the row just didn't name a role".
        expect(gateOf('identity.ticket.issue')).toBe('public');
    });

    /**
     * Stored mail on api.surfdns.net became readable without signing in (2026-09-25): rows for
     * emailMessage.get/find were added with the role left off, and an anonymous caller acts as the
     * api's own tenant. A row that would make a contract callable by anyone must now say so.
     */
    describe('refusing an accidentally public row', () => {
        const meta = async () => ({ meta: { tenant_id: (await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' }))?.tenantId ?? '' } });

        it('refuses a row with no gate, on a contract that demands none, unless public is said', async () => {
            const m = await meta();
            await broker.call('serve.expose.remove', { apiId, contract: 'identity.organization.get' }, m).catch(() => undefined);

            await expect(broker.call('serve.expose.add', { apiId, contract: 'identity.organization.get' }, m)).rejects.toThrow(/callable by anyone.*public: true/);
            await expect(broker.call('serve.expose.add', { apiId, contract: 'identity.organization.get', public: true }, m)).resolves.toMatchObject({ contract: 'identity.organization.get' });
        });

        it('allows a row with no gate when the contract has its own floor', async () => {
            const m = await meta();
            await broker.call('serve.expose.remove', { apiId, contract: 'identity.user.grantRole' }, m).catch(() => undefined);

            await expect(broker.call('serve.expose.add', { apiId, contract: 'identity.user.grantRole' }, m)).resolves.toMatchObject({ contract: 'identity.user.grantRole' });
        });

        it('refuses an ungated event unless public is said', async () => {
            const m = await meta();
            await expect(broker.call('serve.expose.add', { apiId, kind: 'event', contract: 'serve.part.stopped' }, m)).rejects.toThrow(/callable by anyone/);
        });
    });

    /**
     * serve.repo and the gitserver's repo CRUD were both `/repos` on api.surfdns.net: whichever row
     * matched first answered for both, so serve.repo.find returned gitserver repos and
     * serve.repo.find_one (GET /repos/one) was answered by a `get` that read "one" as an id.
     */
    describe('route collisions', () => {
        const meta = async () => ({ meta: { tenant_id: (await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' }))?.tenantId ?? '' } });

        it('refuses exposing a second contract on a route shape already exposed', async () => {
            broker.registry.registerNode({
                nodeID: 'peer-dup',
                type: 'node',
                namespace: 'default',
                addresses: ['ws://127.0.0.1:16598'],
                available: true,
                timestamp: Date.now(),
                nodeSeq: 1,
                services: [{
                    name: 'dupsvc',
                    tools: Object.fromEntries(['first', 'second'].map((action) => [`dupsvc.${action}`, {
                        name: `dupsvc.${action}`,
                        description: 'Same route as its sibling.',
                        visibility: 'public',
                        rest: { method: 'GET', path: action === 'first' ? '/dup/:id' : '/dup/:itemId' },
                        roles: ['operator'],
                        metadata: { domain: 'dupsvc', action, isCrud: false, destructive: false },
                        params: { type: 'object', properties: {} },
                        returns: { type: 'object' },
                    }])),
                }],
            });
            const m = await meta();

            await broker.call('serve.expose.add', { apiId, contract: 'dupsvc.first' }, m);
            await expect(broker.call('serve.expose.add', { apiId, contract: 'dupsvc.second' }, m))
                .rejects.toThrow(/"dupsvc.second" and "dupsvc.first" are both GET \/dup\/:/);
        });

        it('answers a literal path with the contract that names it, not a parameter route listed first', async () => {
            // Rows come back ordered by contract name, and the live case crossed domains: the
            // gitserver's repo.get (/repos/:id) sorts before serve.repo.find_one (/repos/one).
            // aaspec.byid sorts first the same way; only it is gated, so which one answered shows
            // in the status alone.
            broker.registry.registerNode({
                nodeID: 'peer-spec',
                type: 'node',
                namespace: 'default',
                addresses: ['ws://127.0.0.1:16597'],
                available: true,
                timestamp: Date.now(),
                nodeSeq: 1,
                services: [{
                    name: 'spec',
                    tools: {
                        'aaspec.byid': {
                            name: 'aaspec.byid', description: 'One by id.', visibility: 'public',
                            rest: { method: 'GET', path: '/spec/:id' }, roles: ['operator'],
                            metadata: { domain: 'aaspec', action: 'byid', isCrud: false, destructive: false },
                            params: { type: 'object', properties: {} }, returns: { type: 'object' },
                        },
                        'zzspec.one': {
                            name: 'zzspec.one', description: 'The literal route.', visibility: 'public',
                            rest: { method: 'GET', path: '/spec/one' }, roles: [],
                            metadata: { domain: 'zzspec', action: 'one', isCrud: false, destructive: false },
                            params: { type: 'object', properties: {} }, returns: { type: 'object' },
                        },
                    },
                }],
            });
            const m = await meta();
            await broker.call('serve.expose.add', { apiId, contract: 'aaspec.byid' }, m);
            await broker.call('serve.expose.add', { apiId, contract: 'zzspec.one', public: true }, m);

            // The peer is not really there, so the call itself fails -- but not with the 401 that
            // aaspec.byid's gate would have given an anonymous caller.
            const res = await fetch(`${ORIGIN}/api/spec/one`);
            expect(res.status).not.toBe(401);
            expect((await fetch(`${ORIGIN}/api/spec/abc`)).status).toBe(401);
        }, 30_000);
    });

    /**
     * The api publishes contracts that run on other nodes. It used to consult only this node's own
     * definitions, so smtp.capture_list -- which runs on surf, while the api runs on edge1 -- was
     * refused as "not a public contract". A peer's presence now carries the declaration.
     */
    it('exposes and describes a contract only a peer runs, from what that peer advertises', async () => {
        const meta = { meta: { tenant_id: (await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' }))?.tenantId ?? '' } };
        broker.registry.registerNode({
            nodeID: 'peer-surf',
            type: 'node',
            namespace: 'default',
            addresses: ['ws://127.0.0.1:16599'],
            available: true,
            timestamp: Date.now(),
            nodeSeq: 1,
            services: [{
                name: 'remotesvc',
                tools: {
                    'remotesvc.capture_list': {
                        name: 'remotesvc.capture_list',
                        description: 'Runs only on the peer.',
                        visibility: 'public',
                        rest: { method: 'GET', path: '/remotesvc/captures' },
                        roles: ['operator'],
                        metadata: { domain: 'remotesvc', action: 'capture_list', isCrud: false, destructive: false },
                        params: { type: 'object', properties: { limit: { type: 'number' } } },
                        returns: { type: 'object' },
                    },
                },
            }],
        });

        await broker.call('serve.expose.add', { apiId, contract: 'remotesvc.capture_list' }, meta);

        const descriptor = await json(await fetch(`${ORIGIN}/api/_describe`)) as { calls: { key: string; path: string; gate: string }[] };
        expect(descriptor.calls.find((c) => c.key === 'remotesvc.capture_list')).toMatchObject({ path: '/remotesvc/captures', gate: 'operator' });

        // Gated like any other: the peer's permissions are the floor.
        const anonymous = await fetch(`${ORIGIN}/api/remotesvc/captures`);
        expect(anonymous.status).toBe(401);
    });

    /**
     * `find` returns 100 rows unless told otherwise, and the gateway once read only those: the 101st
     * row exposed on api.surfdns.net took serve.part.update and serve.repo.* off the api -- 404 on
     * call, gone from the descriptor -- with no error anywhere. Runs last: it leaves 150 extra rows.
     */
    it('routes and describes a row past the hundredth', async () => {
        const exposes = broker.getProvider<Database>('database').collection('serve.expose').rawCollection;
        const whoamiRow = await exposes.findOne({ apiId, contract: 'identity.whoami' });
        if (whoamiRow === null) throw new Error('identity.whoami is not exposed');

        // Filler rows naming contracts that do not exist: skipped by the gateway, but they count.
        await exposes.insertMany(Array.from({ length: 150 }, (_, i) => ({ tenantId: whoamiRow.tenantId, apiId, kind: 'contract', contract: `filler.nothing${i}`, createdAt: new Date(), updatedAt: new Date() })));
        // Re-expose whoami after them, so it sorts past the first hundred.
        await exposes.deleteOne({ apiId, contract: 'identity.whoami' });
        await exposes.insertOne({ tenantId: whoamiRow.tenantId, apiId, kind: 'contract', contract: 'identity.whoami', createdAt: new Date(), updatedAt: new Date() });
        expect(await exposes.countDocuments({ apiId })).toBeGreaterThan(150);

        const called = await fetch(`${ORIGIN}/api/identity/whoami`, { headers: { authorization: `Bearer ${memberToken}` } });
        expect(called.status).toBe(200);

        const descriptor = await json(await fetch(`${ORIGIN}/api/_describe`)) as { calls: { key: string }[] };
        expect(descriptor.calls.map((c) => c.key)).toContain('identity.whoami');
    });
});
