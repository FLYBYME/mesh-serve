/**
 * The approved list, over real HTTP. The gateway holds every destructive call made with an api
 * token for an operator's decision (202, a serve.hold row). An operator may approve one exposed
 * contract (serve.expose.hold, the row's `unheld`): token calls to it then run at once. A workspace's
 * daemon reports in with destructive calls and could never become ready while each was held
 * (2026-10-05).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, defaultPrint, defineContract, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule, z,
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
import '../src/hold/contracts/hold.contract.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-hold-integration-test';
const WS_PORT = 16572;
const API_PORT = 15572;
const ORIGIN = `http://api.localhost:${API_PORT}`;

describe('the approved list: destructive token calls are held, unless an operator approved that one contract', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let apiId = '';
    let platform = '';
    let token = '';
    let operator = '';
    const meta = (): { meta: { tenant_id: string } } => ({ meta: { tenant_id: platform } });

    const createRepo = async (name: string): Promise<number> => {
        const res = await fetch(`${ORIGIN}/api/sourceRepos`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ tenantId: platform, url: `https://example.invalid/${name}.git`, defaultBranch: 'main', name }),
        });
        await res.text();

        return res.status;
    };

    const repoNamed = async (name: string): Promise<boolean> => {
        const rows = await broker.call('serve.repo.find', { query: { name } }, meta());

        return rows.length > 0;
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'hold-node', logger: new Logger(LogLevel.ERROR) });
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
        await broker.loadDomain('serve.hold', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.holdRule', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        operator = (await broker.call('identity.user.create', {
            email: 'operator@hold.invalid', displayName: 'operator', roles: ['operator'], provisional: false,
        })).id;
        platform = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;

        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        apiId = api.id;

        await broker.call('serve.expose.remove', { apiId, contract: 'serve.repo.create' }, meta()).catch(() => undefined);
        await broker.call('serve.expose.add', { apiId, contract: 'serve.repo.create', role: 'operator' }, meta());

        const asOperator = { meta: { user: { id: operator, tenant_id: platform, organizationId: platform } } };
        token = (await broker.call('identity.apiToken.issue', { name: 'agent-like', userId: operator, organizationId: platform }, asOperator)).token;
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('holds a destructive token call by default: 202, and nothing made', async () => {
        expect(broker.contractDeclaration('serve.repo.create')?.destructive).toBe(true);

        expect(await createRepo('held-by-default')).toBe(202);
        expect(await repoNamed('held-by-default')).toBe(false);
    });

    it('runs it at once once an operator approves that contract, and holds it again when the approval is taken back', async () => {
        const approved = await broker.call('serve.expose.hold', { apiId, contract: 'serve.repo.create', hold: false }, meta());
        expect(approved).toMatchObject({ contract: 'serve.repo.create', unheld: true });

        // The gateway reads its exposure rows on a short cache: wait for it to see the change.
        await vi.waitFor(async () => {
            const status = await createRepo(`approved-${Date.now()}`);
            expect(status).toBeLessThan(300);
            expect(status).not.toBe(202);
        }, { timeout: 20_000, interval: 500 });

        await broker.call('serve.expose.hold', { apiId, contract: 'serve.repo.create', hold: true }, meta());
        await vi.waitFor(async () => expect(await createRepo(`held-again-${Date.now()}`)).toBe(202), { timeout: 20_000, interval: 500 });
    }, 60_000);

    it('an organization\'s own admins let its tokens make a call at once (serve.hold.allow), and take it back', async () => {
        const asAdmin = { meta: { user: { id: 'an-admin', tenant_id: platform, organizationId: platform } } };

        expect(await broker.call('serve.hold.allow', { call: 'serve.repo.create', allowed: true }, asAdmin)).toEqual({ call: 'serve.repo.create', allowed: true });
        expect(await broker.call('serve.holdRule.find', { query: {} }, meta())).toEqual([expect.objectContaining({ tenantId: platform, call: 'serve.repo.create', setBy: 'an-admin' })]);
        await vi.waitFor(async () => {
            const status = await createRepo(`allowed-${Date.now()}`);
            expect(status).toBeLessThan(300);
            expect(status).not.toBe(202);
        }, { timeout: 25_000, interval: 1000 });

        await broker.call('serve.hold.allow', { call: 'serve.repo.create', allowed: false }, asAdmin);
        expect(await broker.call('serve.holdRule.find', { query: {} }, meta())).toEqual([]);
        await vi.waitFor(async () => expect(await createRepo(`held-once-more-${Date.now()}`)).toBe(202), { timeout: 25_000, interval: 1000 });

        // Another organization's rule is not this one's.
        await broker.call('serve.hold.allow', { call: 'serve.repo.create', allowed: true }, { meta: { user: { id: 'x', tenant_id: 'another-org', organizationId: 'another-org' } } });
        expect(await createRepo(`still-held-${Date.now()}`)).toBe(202);
    }, 80_000);

    it('never holds a call carrying a secret: it is refused, and nothing is kept', async () => {
        const vaultSave = defineContract({
            domain: 'testVault', action: 'save', description: 'Test: seal a secret.',
            inputSchema: z.object({ name: z.string(), secret: z.string() }), outputSchema: z.object({ name: z.string() }),
            rest: { method: 'POST', path: '/test-vault/save' }, destructive: true, visibility: 'public',
            filePath: 'test/hold.integration.test.ts', concurrency: 'on-demand', permissions: ['operator'], print: defaultPrint,
        });
        broker.registerContract(vaultSave, async (input) => ({ name: input.name }));
        await broker.call('serve.expose.add', { apiId, contract: 'testVault.save', role: 'operator' }, meta());

        await vi.waitFor(async () => {
            const res = await fetch(`${ORIGIN}/api/test-vault/save`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'db-uri', secret: 'mongodb://user:pw@host/db' }),
            });
            const body = await res.text();
            expect(res.status).toBe(409);
            expect(body).toContain('carries a secret');
            expect(body).not.toContain('user:pw');
        }, { timeout: 20_000, interval: 1000 });

        expect(await broker.call('serve.hold.count', { query: { call: 'testVault.save' } }, meta())).toBe(0);
    }, 40_000);

    it('a held call is decided only in its own organization: another\'s admin does not find it', async () => {
        const [held] = await broker.call('serve.hold.find', { query: { status: 'held' }, limit: 1 }, meta());
        expect(held).toBeDefined();

        const asOtherAdmin = { meta: { user: { id: 'other-admin', tenant_id: 'another-org', organizationId: 'another-org' } } };
        await expect(broker.call('serve.hold.decide', { holdId: held?.id ?? '', approved: true }, asOtherAdmin)).rejects.toMatchObject({ status: 404 });
        expect(await broker.call('serve.hold.find', { query: {} }, asOtherAdmin)).toEqual([]);
    });

    it('refuses a contract that is not exposed on the api', async () => {
        await expect(broker.call('serve.expose.hold', { apiId, contract: 'serve.repo.nothing', hold: false }, meta())).rejects.toThrow(/not exposed/);
    });

    it('operator sees every organization\'s holds with secrets masked, while decide replays real values', async () => {
        expect(broker.contractDeclaration('serve.hold.all')?.permissions).toEqual(['operator']);

        const peerA = (await broker.call('identity.organization.create', { slug: 'peera', name: 'PeerA', ownerId: operator })).id;
        const peerAMeta = { meta: { tenant_id: peerA } };

        const replayTarget = defineContract({
            domain: 'testEcho', action: 'replay', description: 'Test: replay target.',
            inputSchema: z.object({ name: z.string(), secret: z.string() }),
            outputSchema: z.object({ name: z.string(), receivedSecret: z.string() }),
            rest: { method: 'POST', path: '/test-echo/replay' }, destructive: true, visibility: 'public',
            filePath: 'test/hold.integration.test.ts', concurrency: 'on-demand', permissions: ['operator'], print: defaultPrint,
        });
        broker.registerContract(replayTarget, async (input) => ({ name: input.name, receivedSecret: input.secret }));

        const olderDate = new Date(Date.now() - 60_000);
        const newerDate = new Date(Date.now() - 30_000);
        const newestDate = new Date(Date.now());

        const holdPlatform = await broker.call('serve.hold.create', {
            tenantId: platform,
            call: 'testEcho.replay',
            host: 'api.localhost',
            input: { name: 'platform-job', data: 'public-data' },
            requestedBy: { userId: 'user-platform', roles: ['admin'] },
            status: 'held',
            requestedAt: olderDate,
            expiresAt: new Date(Date.now() + 60_000),
        }, meta());

        const holdPeerA = await broker.call('serve.hold.create', {
            tenantId: peerA,
            call: 'testEcho.replay',
            host: 'api.localhost',
            input: { name: 'peera-job', secret: 'peera-real-secret' },
            requestedBy: { userId: 'user-peera', roles: ['admin'] },
            status: 'held',
            requestedAt: newerDate,
            expiresAt: new Date(Date.now() + 60_000),
        }, peerAMeta);

        const holdReleased = await broker.call('serve.hold.create', {
            tenantId: platform,
            call: 'testEcho.replay',
            host: 'api.localhost',
            input: { name: 'released-job' },
            requestedBy: { userId: 'user-platform', roles: ['admin'] },
            status: 'released',
            requestedAt: newestDate,
            expiresAt: new Date(Date.now() + 60_000),
        }, meta());

        const asOperator = { meta: { user: { id: 'op', roles: ['operator'], tenant_id: platform, organizationId: platform } } };

        const allHolds = await broker.call('serve.hold.all', {}, asOperator);
        const ids = allHolds.map((h) => h.id);

        expect(ids).toContain(holdPlatform.id);
        expect(ids).toContain(holdPeerA.id);
        expect(ids).toContain(holdReleased.id);

        const peerRow = allHolds.find((h) => h.id === holdPeerA.id);
        expect(peerRow?.tenantId).toBe(peerA);
        expect(peerRow?.input.secret).toBe('hidden');
        expect(peerRow?.input).not.toMatchObject({ secret: 'peera-real-secret' });

        const platformRow = allHolds.find((h) => h.id === holdPlatform.id);
        expect(platformRow?.tenantId).toBe(platform);

        const relevant = allHolds.filter((h) => h.id === holdPeerA.id || h.id === holdPlatform.id);
        expect(relevant[0]?.id).toBe(holdPeerA.id);
        expect(relevant[1]?.id).toBe(holdPlatform.id);

        const heldFiltered = await broker.call('serve.hold.all', { status: 'held' }, asOperator);
        expect(heldFiltered.every((h) => h.status === 'held')).toBe(true);
        expect(heldFiltered.map((h) => h.id)).toContain(holdPlatform.id);
        expect(heldFiltered.map((h) => h.id)).toContain(holdPeerA.id);
        expect(heldFiltered.map((h) => h.id)).not.toContain(holdReleased.id);

        const releasedFiltered = await broker.call('serve.hold.all', { status: 'released' }, asOperator);
        expect(releasedFiltered.every((h) => h.status === 'released')).toBe(true);
        expect(releasedFiltered.map((h) => h.id)).toContain(holdReleased.id);
        expect(releasedFiltered.map((h) => h.id)).not.toContain(holdPeerA.id);

        const readRow = await broker.call('serve.hold.get', { id: holdPeerA.id }, peerAMeta);
        expect(readRow.input.secret).toBe('hidden');

        const foundRow = await broker.call('serve.hold.find_one', { query: { id: holdPeerA.id } }, peerAMeta);
        expect(foundRow?.input.secret).toBe('hidden');

        const foundRows = await broker.call('serve.hold.find', { query: { id: holdPeerA.id } }, peerAMeta);
        expect(foundRows[0]?.input.secret).toBe('hidden');

        const asOperatorInPeerA = { meta: { user: { id: operator, roles: ['operator'], tenant_id: peerA, organizationId: peerA } } };
        const decided = await broker.call('serve.hold.decide', { holdId: holdPeerA.id, approved: true }, asOperatorInPeerA);
        expect(decided.status).toBe('released');
        expect(decided.result).toEqual({ name: 'peera-job', receivedSecret: 'peera-real-secret' });
    });
});
