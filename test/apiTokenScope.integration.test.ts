/**
 * An api token is held to what it was issued for, over real HTTP (review 10-26). The gateway kept
 * only the token's account: a token issued for one organization acted in any of its account's, and
 * one issued with the member role passed its account's admin and operator gates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, defineContract, defaultPrint, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/agent.contract.js';
import '../src/identity/contracts/identity.contract.js';
import '../src/api/contracts/api.contract.js';
import '../src/api/contracts/expose.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-api-token-scope-integration-test';
const WS_PORT = 16613;
const API_PORT = 15613;
const ORIGIN = `http://api.localhost:${API_PORT}`;

declare global {
    interface IServiceToolRegistry {
        'scopetest.member': { params: Record<string, never>; returns: { tenant: string } };
        'scopetest.admin': { params: Record<string, never>; returns: { tenant: string } };
        'scopetest.operator': { params: Record<string, never>; returns: { tenant: string } };
    }
}

/** A call gated on one role, answering the organization it ran in. */
function gated(action: 'member' | 'admin' | 'operator') {
    return defineContract({
        domain: 'scopetest', action, description: `test: a ${action}'s call`,
        inputSchema: z.object({}), outputSchema: z.object({ tenant: z.string() }),
        rest: { method: 'GET', path: `/scopetest/${action}` }, filePath: 'test/apiTokenScope.integration.test.ts',
        concurrency: 'on-demand', permissions: [action], visibility: 'public', print: defaultPrint,
    });
}

describe('an api token is held to its organization and roles', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const org = { platform: '', beta: '' };
    const tokens: Record<string, string> = {};

    const call = async (action: string, token: string, organization?: string): Promise<{ status: number; tenant?: string }> => {
        const res = await fetch(`${ORIGIN}/api/scopetest/${action}`, {
            headers: { authorization: `Bearer ${token}`, ...(organization !== undefined ? { 'x-organization': organization } : {}) },
        });
        const body: unknown = await res.json();
        const tenant = typeof body === 'object' && body !== null ? Reflect.get(body, 'tenant') : undefined;
        return { status: res.status, ...(typeof tenant === 'string' ? { tenant } : {}) };
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'api-token-scope-node', logger: new Logger(LogLevel.ERROR) });
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

        // The operator owns both organizations.
        const operator = (await broker.call('identity.user.create', {
            email: 'operator@scope.invalid', displayName: 'operator', passwordHash: await hashPassword('a-real-password-for-tests-13'), roles: ['operator'], provisional: false,
        })).id;
        org.platform = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;
        org.beta = (await broker.call('identity.organization.create', { slug: 'beta', name: 'Beta', ownerId: operator })).id;
        const asOperator = { meta: { user: { id: operator, tenant_id: org.platform } } };

        const issue = async (name: string, extra: { organizationId?: string; roles?: string[] }): Promise<void> => {
            tokens[name] = (await broker.call('identity.apiToken.issue', { name, userId: operator, ...extra }, asOperator)).token;
        };
        await issue('whole', {});
        await issue('beta-only', { organizationId: org.beta });
        await issue('member-only', { organizationId: org.beta, roles: ['member'] });

        const actions: ReadonlyArray<'member' | 'admin' | 'operator'> = ['member', 'admin', 'operator'];
        for (const action of actions) {
            broker.registerContract(gated(action), async (_input, ctx) => {
                const user = ctx.meta?.user;
                const tenant = typeof user === 'object' && user !== null ? Reflect.get(user, 'tenant_id') : undefined;
                return { tenant: typeof tenant === 'string' ? tenant : '' };
            });
        }

        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        for (const action of ['member', 'admin', 'operator']) {
            await broker.call('serve.expose.add', { apiId: api.id, contract: `scopetest.${action}` }, { meta: { tenant_id: org.platform } });
        }
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('a token with no scope acts as its account: any organization it names, operator calls too', async () => {
        const whole = tokens['whole'] ?? '';
        expect(await call('operator', whole, org.beta)).toEqual({ status: 200, tenant: org.beta });
        expect(await call('admin', whole, org.platform)).toEqual({ status: 200, tenant: org.platform });
    });

    it('a token issued for an organization runs there, and naming another is refused', async () => {
        const betaOnly = tokens['beta-only'] ?? '';
        expect(await call('admin', betaOnly)).toEqual({ status: 200, tenant: org.beta });
        expect(await call('admin', betaOnly, org.beta)).toEqual({ status: 200, tenant: org.beta });
        expect((await call('admin', betaOnly, org.platform)).status).toBe(403);
    });

    it('a token that names roles passes only their gates, never its account\'s higher ones', async () => {
        const memberOnly = tokens['member-only'] ?? '';
        expect(await call('member', memberOnly)).toEqual({ status: 200, tenant: org.beta });
        expect((await call('admin', memberOnly)).status).toBe(403);
        expect((await call('operator', memberOnly)).status).toBe(403);
    });
});
