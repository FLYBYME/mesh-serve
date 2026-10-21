/**
 * A call made with an api token says which token, over real HTTP (design/workflows.md, "The step
 * catalog"): a workflow job's token is that job, and one account (an organization's ci agent) holds
 * one token per running job. The account alone cannot tell them apart; the token's id can.
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

const DB_NAME = 'mesh-serve-api-token-meta-integration-test';
const WS_PORT = 16612;
const API_PORT = 15612;
const ORIGIN = `http://api.localhost:${API_PORT}`;
const PASSWORD = 'a-real-password-for-tests-12';

declare global {
    interface IServiceToolRegistry {
        'tokentest.whoami': { params: Record<string, never>; returns: { id: string; tenant: string; apiTokenId: string; apiTokenName: string } };
    }
}

/** An agent's call, answering which account and which token it ran as. */
const whoamiContract = defineContract({
    domain: 'tokentest', action: 'whoami', description: 'test: which token a call runs as',
    inputSchema: z.object({}),
    outputSchema: z.object({ id: z.string(), tenant: z.string(), apiTokenId: z.string(), apiTokenName: z.string() }),
    rest: { method: 'GET', path: '/tokentest/whoami' }, filePath: 'test/apiTokenMeta.integration.test.ts',
    concurrency: 'on-demand', permissions: ['agent'], visibility: 'public', print: defaultPrint,
});

describe('a call made with an api token', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let orgId = '';
    let agentId = '';
    const tokens: Record<string, { token: string; id: string }> = {};

    const call = async (token: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`${ORIGIN}/api/tokentest/whoami`, { headers: { authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json() };
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'api-token-meta-node', logger: new Logger(LogLevel.ERROR) });
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

        const operator = (await broker.call('identity.user.create', {
            email: 'operator@tokens.invalid', displayName: 'operator', passwordHash: await hashPassword(PASSWORD), roles: ['operator'], provisional: false,
        })).id;
        orgId = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;
        const asOperator = { meta: { user: { id: operator, tenant_id: orgId } } };

        // One account, two jobs: two tokens.
        agentId = (await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'ci' }, asOperator)).userId;
        for (const name of ['job-one', 'job-two']) {
            const issued = await broker.call('identity.apiToken.issue', { name, userId: agentId, organizationId: orgId, roles: ['agent'] }, asOperator);
            const checked = await broker.call('identity.apiToken.validate', { token: issued.token });
            tokens[name] = { token: issued.token, id: checked.id ?? '' };
        }

        broker.registerContract(whoamiContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            const field = (key: string): string => {
                const value = typeof user === 'object' && user !== null ? Reflect.get(user, key) : undefined;
                return typeof value === 'string' ? value : '';
            };
            return { id: field('id'), tenant: field('tenant_id'), apiTokenId: field('apiTokenId'), apiTokenName: field('apiTokenName') };
        });

        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'tokentest.whoami' }, { meta: { tenant_id: orgId } });
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('says which of the account\'s tokens it is: two tokens of one account are two callers', async () => {
        const one = tokens['job-one'];
        const two = tokens['job-two'];
        if (one === undefined || two === undefined) throw new Error('no tokens issued');
        expect(one.id).not.toBe('');
        expect(one.id).not.toBe(two.id);

        expect(await call(one.token)).toEqual({ status: 200, body: { id: agentId, tenant: orgId, apiTokenId: one.id, apiTokenName: 'job-one' } });
        expect(await call(two.token)).toEqual({ status: 200, body: { id: agentId, tenant: orgId, apiTokenId: two.id, apiTokenName: 'job-two' } });
    });

    it('a person\'s ticket names no token', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'operator@tokens.invalid', password: PASSWORD }),
        });
        const body: unknown = await res.json();
        const ticket = typeof body === 'object' && body !== null ? Reflect.get(body, 'token') : undefined;
        if (typeof ticket !== 'string') throw new Error('no ticket');

        const answer = await call(ticket);
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ apiTokenId: '', apiTokenName: '' });
    });
});
