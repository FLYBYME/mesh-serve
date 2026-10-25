/**
 * An api whose protocol is mcp (design/mcp.md), over real HTTP: its exposure rows are its tools,
 * listed only where the caller passes their gate, and a tools/call goes through the same path as a
 * REST call -- gate, organization, a token's destructive call held, the activity log.
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
import '../src/hold/contracts/hold.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-mcp-integration-test';
const WS_PORT = 16613;
const API_PORT = 15613;
const MCP = `http://mcp.localhost:${API_PORT}/`;

declare global {
    interface IServiceToolRegistry {
        'mcptest.zones': { params: { name?: string }; returns: { zones: string[]; tenant: string } };
        'mcptest.remove': { params: { name: string }; returns: { removed: string } };
        'mcptest.operatorOnly': { params: Record<string, never>; returns: { ok: boolean } };
    }
}

const contract = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(action: string, inputSchema: I, outputSchema: O, method: 'GET' | 'POST', permissions: string[], destructive: boolean) => defineContract({
    domain: 'mcptest', action, description: `test: ${action}`, inputSchema, outputSchema,
    rest: { method, path: `/mcptest/${action}` }, filePath: 'test/mcp.integration.test.ts',
    concurrency: 'on-demand', permissions, visibility: 'public', print: defaultPrint, destructive,
});

const zonesContract = contract('zones', z.object({ name: z.string().optional() }), z.object({ zones: z.array(z.string()), tenant: z.string() }), 'GET', ['agent'], false);
const removeContract = contract('remove', z.object({ name: z.string() }), z.object({ removed: z.string() }), 'POST', ['agent'], true);
const operatorOnlyContract = contract('operatorOnly', z.object({}), z.object({ ok: z.boolean() }), 'GET', ['operator'], false);

describe('an mcp api', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let orgId = '';
    let agentToken = '';
    let removed: string[] = [];

    /** `id` null: a notification. */
    const rpc = async (method: string, params: Record<string, unknown> = {}, token = agentToken, id: number | null = 1): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(MCP, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token !== '' ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== null ? { id } : {}) }),
        });
        const text = await res.text();

        return { status: res.status, body: text === '' ? undefined : JSON.parse(text) };
    };
    const result = (body: unknown): Record<string, unknown> => {
        const value: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined;
        if (typeof value !== 'object' || value === null) throw new Error(`no result in ${JSON.stringify(body)}`);

        return Object.fromEntries(Object.entries(value));
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'mcp-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        for (const domain of ['identity', 'serve.api', 'serve.expose', 'serve.activity', 'serve.hold', 'serve.holdRule']) {
            await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        }
        await broker.call('identity.role.ensureBuiltins', {});

        const operator = (await broker.call('identity.user.create', {
            email: 'operator@mcp.invalid', displayName: 'operator', passwordHash: await hashPassword('a-real-password-for-tests-13'), roles: ['operator'], provisional: false,
        })).id;
        orgId = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;
        const asOperator = { meta: { user: { id: operator, tenant_id: orgId } } };
        const agent = (await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'floor-watcher' }, asOperator)).userId;
        agentToken = (await broker.call('identity.apiToken.issue', { name: 'claude', userId: agent, organizationId: orgId, roles: ['agent'] }, asOperator)).token;

        broker.registerContract(zonesContract, async (input, ctx) => {
            const tenant = ctx.meta?.user?.tenant_id;
            return { zones: ['surfdns.net', 'peera.ca'].filter((z) => input.name === undefined || z === input.name), tenant: typeof tenant === 'string' ? tenant : '' };
        });
        broker.registerContract(removeContract, async (input) => {
            removed = [...removed, input.name];
            return { removed: input.name };
        });
        broker.registerContract(operatorOnlyContract, async () => ({ ok: true }));

        await ensureBootstrapApi(broker);
        await broker.call('serve.api.create', { tenantId: orgId, apiHost: 'mcp.localhost', protocol: 'mcp', description: 'The floor, for agents' }, { meta: { tenant_id: orgId } });
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'mcp.localhost' });
        if (api === undefined) throw new Error('mcp api was not created');
        for (const key of ['mcptest.zones', 'mcptest.remove', 'mcptest.operatorOnly']) {
            await broker.call('serve.expose.add', { apiId: api.id, contract: key }, { meta: { tenant_id: orgId } });
        }
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('initializes, in the version asked for when it speaks it', async () => {
        const answer = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(answer.status).toBe(200);
        expect(result(answer.body)).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mcp.localhost' } });

        expect(result((await rpc('initialize', { protocolVersion: '1999-01-01' })).body)).toMatchObject({ protocolVersion: '2025-06-18' });
        // A notification wants no answer.
        expect(await rpc('notifications/initialized', {}, agentToken, null)).toEqual({ status: 202, body: undefined });
    });

    it('lists its rows as tools, only those the caller passes the gate of', async () => {
        const tools = result((await rpc('tools/list')).body)['tools'];
        expect(tools).toEqual([
            expect.objectContaining({ name: 'mcptest_remove', title: 'mcptest.remove', annotations: { readOnlyHint: false, destructiveHint: true } }),
            expect.objectContaining({
                name: 'mcptest_zones', title: 'mcptest.zones', annotations: { readOnlyHint: true, destructiveHint: false },
                inputSchema: expect.objectContaining({ type: 'object', properties: expect.objectContaining({ name: expect.anything() }) }),
            }),
        ]);

        // No token: no tool needing one.
        expect(result((await rpc('tools/list', {}, '')).body)['tools']).toEqual([]);
    });

    it('a call runs in the caller\'s organization, its answer as text and structured content', async () => {
        const answer = result((await rpc('tools/call', { name: 'mcptest_zones', arguments: { name: 'peera.ca' } })).body);
        expect(answer).toEqual({
            content: [{ type: 'text', text: JSON.stringify({ zones: ['peera.ca'], tenant: orgId }) }],
            structuredContent: { zones: ['peera.ca'], tenant: orgId },
            isError: false,
        });
    });

    it('a token\'s destructive call is held, not run, and says so', async () => {
        const answer = result((await rpc('tools/call', { name: 'mcptest_remove', arguments: { name: 'peera.ca' } })).body);
        expect(answer['isError']).toBe(false);
        expect(JSON.stringify(answer['content'])).toContain('held for a decision');
        expect(removed).toEqual([]);

        const holds = await broker.call('serve.hold.find', { query: { call: 'mcptest.remove' } }, { meta: { tenant_id: orgId } });
        expect(holds).toEqual([expect.objectContaining({ status: 'held', host: 'mcp.localhost', input: { name: 'peera.ca' } })]);
    });

    it('a refused call is the tool\'s answer, an error the model can read', async () => {
        const refused = result((await rpc('tools/call', { name: 'mcptest_operatorOnly', arguments: {} })).body);
        expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('requires role "operator"') }] });

        const unknown = result((await rpc('tools/call', { name: 'nope', arguments: {} })).body);
        expect(unknown).toMatchObject({ isError: true });

        const invalid = result((await rpc('tools/call', { name: 'mcptest_zones', arguments: { name: 5 } })).body);
        expect(invalid['isError']).toBe(true);
    });

    it('answers POST only, and says what it does not know', async () => {
        const get = await fetch(MCP);
        expect(get.status).toBe(405);

        const unknown = await rpc('resources/list');
        expect(unknown.body).toMatchObject({ error: { code: -32601 } });
    });
});
