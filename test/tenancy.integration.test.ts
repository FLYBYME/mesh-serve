/**
 * Whose organization a call runs in, over real HTTP.
 *
 * Until 2026-10-01 every call on an api ran in the api's own organization (the platform's), whoever
 * made it; only `role: operator` on every customer-facing exposure row kept a customer from reading
 * the platform's data. A signed-in member's gated call now runs in one of their own organizations,
 * checked against identity.membership every time (gateway.ts callOrganization). These tests stand
 * three organizations side by side and prove none sees another's rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const DB_NAME = 'mesh-serve-tenancy-integration-test';
const WS_PORT = 16571;
const API_PORT = 15571;
const ORIGIN = `http://api.localhost:${API_PORT}`;
const PASSWORD = 'a-real-password-for-tests-12';

describe('a member\'s call runs in their own organization, never another', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const token: Record<string, string> = {};
    const orgId: Record<string, string> = {};
    const userId: Record<string, string> = {};

    const repos = async (who: string, organization?: string): Promise<{ status: number; names?: string[]; error?: string }> => {
        const res = await fetch(`${ORIGIN}/api/sourceRepos`, {
            headers: { authorization: `Bearer ${token[who]}`, ...(organization !== undefined ? { 'x-organization': organization } : {}) },
        });
        const body = await res.json() as { error?: string } | { name: string }[];
        return Array.isArray(body) ? { status: res.status, names: body.map((r) => r.name).sort() } : { status: res.status, error: body.error ?? '' };
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'tenancy-node', logger: new Logger(LogLevel.ERROR) });
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
            email: `${key}@tenancy.invalid`, displayName: key, passwordHash: await hashPassword(PASSWORD), roles, provisional: false,
        })).id;
        const operator = await user('operator', ['operator']);
        userId.operator = operator;
        const ada = await user('ada', []);
        const two = await user('two', []);
        await user('stranger', []);

        // Each organization's owner is made its member by organization.create's own hook.
        orgId.platform = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;
        orgId.peera = (await broker.call('identity.organization.create', { slug: 'peera', name: 'Peera', ownerId: ada })).id;
        orgId.other = (await broker.call('identity.organization.create', { slug: 'other', name: 'Other', ownerId: two })).id;
        // `two` owns Other and is a plain member of Peera: two organizations, so must name one.
        await broker.call('identity.membership.create', { userId: two, organizationId: orgId.peera, roleKey: 'member', joinedAt: new Date() },
            { meta: { user: { id: two, tenant_id: orgId.peera, organizationId: orgId.peera } } });

        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        expect(api.tenantId).toBe(orgId.platform);

        for (const [org, name] of [['platform', 'platform-repo'], ['peera', 'peera-repo'], ['other', 'other-repo']] as const) {
            await broker.call('serve.repo.create', { tenantId: orgId[org]!, url: `https://example.invalid/${name}.git`, defaultBranch: 'main', name },
                { meta: { tenant_id: orgId[org] } });
        }
        // A customer-facing row: any member of the organization the call runs in.
        const meta = { meta: { tenant_id: orgId.platform } };
        await broker.call('serve.expose.remove', { apiId: api.id, contract: 'serve.repo.find' }, meta).catch(() => undefined);
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'serve.repo.find', role: 'member' }, meta);

        for (const who of ['operator', 'ada', 'two', 'stranger']) {
            const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: `${who}@tenancy.invalid`, password: PASSWORD }),
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

    it('a customer sees only their own organization\'s rows -- never the platform\'s', async () => {
        expect(await repos('ada')).toEqual({ status: 200, names: ['peera-repo'] });
    });

    it('refuses an organization the caller is not a member of, rather than falling back to one', async () => {
        const res = await repos('ada', orgId.platform);
        expect(res.status).toBe(403);
        expect(res.error).toMatch(/not a member of that organization/);
        expect((await repos('ada', orgId.other)).status).toBe(403);
    });

    it('an account in no organization reads nothing, instead of acting as the platform', async () => {
        const res = await repos('stranger');
        expect(res.status).toBe(403);
        expect(res.error).toMatch(/belongs to no organization/);
    });

    it('a member of several must name one, and gets exactly that one', async () => {
        expect((await repos('two')).status).toBe(400);
        expect(await repos('two', orgId.peera)).toEqual({ status: 200, names: ['peera-repo'] });
        expect(await repos('two', orgId.other)).toEqual({ status: 200, names: ['other-repo'] });
    });

    it('an operator still works in the api\'s own organization', async () => {
        expect(await repos('operator')).toEqual({ status: 200, names: ['platform-repo'] });
    });

    // design/organization-scoping.md (2026-10-03): operators see every organization only on
    // operator rows; on a member row, naming an organization makes them a member like any other.
    it('an operator naming one of their organizations on a member row gets exactly that one', async () => {
        expect(await repos('operator', orgId.peera)).toEqual({ status: 403, error: expect.stringMatching(/not a member of that organization/) });

        await broker.call('identity.membership.create', { userId: userId.operator, organizationId: orgId.peera, roleKey: 'member', joinedAt: new Date() },
            { meta: { user: { id: userId.operator, tenant_id: orgId.peera, organizationId: orgId.peera } } });

        await vi.waitFor(async () => expect(await repos('operator', orgId.peera)).toEqual({ status: 200, names: ['peera-repo'] }), { timeout: 20_000, interval: 500 });
        expect(await repos('operator', orgId.platform)).toEqual({ status: 200, names: ['platform-repo'] });
        // Naming none: the api's own, as before -- a client that never names one is unchanged.
        expect(await repos('operator')).toEqual({ status: 200, names: ['platform-repo'] });
    }, 30_000);

    it('on an operator-only row an operator works in the api\'s own, whatever the request names', async () => {
        const meta = { meta: { tenant_id: orgId.platform } };
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('no api');

        await broker.call('serve.expose.remove', { apiId: api.id, contract: 'serve.repo.find' }, meta);
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'serve.repo.find', role: 'operator' }, meta);
        try {
            await vi.waitFor(async () => expect(await repos('operator', orgId.peera)).toEqual({ status: 200, names: ['platform-repo'] }), { timeout: 20_000, interval: 500 });
        } finally {
            await broker.call('serve.expose.remove', { apiId: api.id, contract: 'serve.repo.find' }, meta);
            await broker.call('serve.expose.add', { apiId: api.id, contract: 'serve.repo.find', role: 'member' }, meta);
        }
    }, 30_000);

    it('a public call still runs for the api\'s owner, signed in or not', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/whoami`, { headers: { authorization: `Bearer ${token.ada}` } });
        expect(res.status).toBe(200);
        expect((await res.json() as { organizations: { name: string }[] }).organizations.map((o) => o.name)).toEqual(['Peera']);
    });

    // Last: it changes Ada's password.
    it('keeps an activity log: changes and refusals, who and in which organization, never a password', async () => {
        // A refusal (Ada naming an organization she is not in) and a change (Ada setting her
        // password -- destructive, with a secret in it).
        await repos('ada', orgId.platform);
        const res = await fetch(`${ORIGIN}/api/identity/password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token.ada}` },
            body: JSON.stringify({ currentPassword: PASSWORD, password: 'a-brand-new-password-34' }),
        });
        expect(res.status).toBe(200);

        const rows = await vi.waitFor(async () => {
            const found = await broker.call('serve.activity.find', { query: {}, limit: 100 });
            if (!found.some((r) => r.contract === 'identity.user.setPassword') || !found.some((r) => r.outcome === 'refused')) throw new Error('not yet');
            return found;
        }, { timeout: 5000, interval: 100 });

        const refused = rows.find((r) => r.outcome === 'refused' && r.contract === 'serve.repo.find');
        expect(refused?.actor.userId).not.toBe('');
        const change = rows.find((r) => r.contract === 'identity.user.setPassword');
        expect(change).toMatchObject({ outcome: 'ok' });
        expect(change?.input).toContain('[redacted]');
        expect(change?.input).not.toContain('a-brand-new-password-34');
        expect(change?.input).not.toContain(PASSWORD);
        expect(change?.ip).not.toBe('');
        // Reads that succeed are not kept.
        expect(rows.some((r) => r.contract === 'serve.repo.find' && r.outcome === 'ok')).toBe(false);

        // A customer sees their own organization's activity and their own actions -- nobody else's,
        // and never where a call came from.
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('no api');
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'serve.activity.mine', role: 'member' }, { meta: { tenant_id: orgId.platform } });
        // Someone else's change, in another organization: Ada must not see it.
        await fetch(`${ORIGIN}/api/identity/password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token.two}` },
            body: JSON.stringify({ currentPassword: PASSWORD, password: 'twos-new-password-56' }),
        });
        const mine = await vi.waitFor(async () => {
            const r = await fetch(`${ORIGIN}/api/activity/mine`, { headers: { authorization: `Bearer ${token.ada}` } });
            expect(r.status).toBe(200);
            const body = await r.json() as { rows: { contract: string; outcome: string; actor: { userId: string } }[] };
            if (!body.rows.some((x) => x.contract === 'identity.user.setPassword')) throw new Error('not yet');
            return body.rows;
        }, { timeout: 5000, interval: 100 });
        const adaId = rows.find((r) => r.contract === 'identity.user.setPassword')?.actor.userId;
        expect(mine.every((x) => x.actor.userId === adaId)).toBe(true);
        // Her password change, and her refusals from the earlier tests (two organizations not hers).
        expect([...new Set(mine.map((x) => x.outcome))].sort()).toEqual(['ok', 'refused']);
        expect(JSON.stringify(mine)).not.toMatch(/"ip"|forwardedFor|userAgent/);
    });

});
