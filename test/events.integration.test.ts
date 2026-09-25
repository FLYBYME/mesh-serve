/**
 * `/api/events` over real HTTP: an api's exposed events, streamed as Server-Sent Events.
 *
 * The rule under test is the one the first version of this stream (removed in the Sep 11 rebuild)
 * was built on: an event that cannot be scoped is delivered to nobody, and a subscription that
 * could never deliver is refused with its reasons rather than accepted and left silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, defineEvent, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z,
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

const DB_NAME = 'mesh-serve-events-integration-test';
const WS_PORT = 16562;
const API_PORT = 15562;
const ORIGIN = `http://api.localhost:${API_PORT}`;
const PASSWORD = 'a-real-operator-password-12';

// An event whose author never said who it belongs to -- it must never be streamable.
defineEvent('eventstest.unscoped', z.object({ n: z.number() }));

/** One open subscription: collects the raw stream until told what to wait for. */
interface Subscription {
    readonly status: number;
    readonly body: string;
    waitFor(text: string, ms?: number): Promise<string>;
    received(): string;
    close(): void;
}

async function subscribe(query: string, token?: string): Promise<Subscription> {
    const controller = new AbortController();
    const res = await fetch(`${ORIGIN}/api/events${query}`, {
        headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
    });
    if (!res.ok || res.body === null) {
        const body = await res.text();
        return { status: res.status, body, waitFor: async () => '', received: () => '', close: () => {} };
    }

    let text = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                text += decoder.decode(value, { stream: true });
            }
        } catch {
            // Aborted by close().
        }
    })();

    return {
        status: res.status,
        body: '',
        async waitFor(expected, ms = 2000) {
            const until = Date.now() + ms;
            while (!text.includes(expected)) {
                if (Date.now() > until) throw new Error(`stream never contained ${JSON.stringify(expected)}; got:\n${text}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return text;
        },
        received: () => text,
        close: () => controller.abort(),
    };
}

const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('/api/events', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let operatorToken = '';
    let memberToken = '';
    let apiId = '';
    let orgId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'events-node', logger: new Logger(LogLevel.ERROR) });
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
            email: 'op@events.invalid', displayName: 'Op', passwordHash: await hashPassword(PASSWORD),
            roles: ['operator'], provisional: false,
        });
        const org = await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator.id });
        orgId = org.id;
        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        apiId = api.id;

        const member = await broker.call('identity.user.create', {
            email: 'member@events.invalid', displayName: 'Member', passwordHash: await hashPassword(PASSWORD),
            roles: [], provisional: false,
        });
        await broker.call('identity.membership.create', {
            userId: member.id, organizationId: org.id, roleKey: 'member', joinedAt: new Date(),
        }, { meta: { user: { id: member.id, tenant_id: '', organizationId: org.id } } });

        const meta = { meta: { tenant_id: org.id } };
        await broker.call('serve.expose.add', { apiId, kind: 'event', contract: 'serve.part.failed', role: 'operator' }, meta);
        await broker.call('serve.expose.add', { apiId, kind: 'event', contract: 'serve.part.started' }, meta);

        for (const [email, target] of [['op@events.invalid', 'operator'], ['member@events.invalid', 'member']] as const) {
            const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email, password: PASSWORD }),
            });
            const ticket = await res.json() as { token: string };
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

    const lifecycle = (tenantId: string, key: string): { tenantId: string; partId: string; key: string; nodeID: string } =>
        ({ tenantId, partId: `p-${key}`, key, nodeID: 'events-node' });

    it('refuses to expose an event nobody could ever be sent, and says why', async () => {
        const meta = { meta: { tenant_id: orgId } };
        await expect(broker.call('serve.expose.add', { apiId, kind: 'event', contract: 'eventstest.unscoped' }, meta))
            .rejects.toThrow(/declares no scopedBy/);
        await expect(broker.call('serve.expose.add', { apiId, kind: 'event', contract: 'nobody.defines.this' }, meta))
            .rejects.toThrow(/no module loaded on this node defines it/);
    });

    it('advertises its events, with their gates, in the descriptor', async () => {
        const descriptor = await (await fetch(`${ORIGIN}/api/_describe`)).json() as { events: unknown[]; calls: Array<{ key: string }> };
        expect(descriptor.events).toEqual([
            { name: 'serve.part.failed', gate: { kind: 'role', role: 'operator' } },
            { name: 'serve.part.started' },
        ]);
        // An event row is never routed as a call.
        expect(descriptor.calls.map((call) => call.key)).not.toContain('serve.part.failed');
    });

    it('streams to an operator every tenant\'s events', async () => {
        const stream = await subscribe('?events=serve.part.failed', operatorToken);
        expect(stream.status).toBe(200);
        await stream.waitFor(': open');

        broker.emit('serve.part.failed', { ...lifecycle(orgId, 'mine'), error: 'boom' });
        broker.emit('serve.part.failed', { ...lifecycle('another-org', 'theirs'), error: 'bang' });

        const text = await stream.waitFor('"key":"theirs"');
        expect(text).toContain('event: serve.part.failed');
        expect(text).toContain('"key":"mine"');
        stream.close();
    });

    it('streams to a member only their own organization\'s events, and names what it left out', async () => {
        const stream = await subscribe('', memberToken);
        expect(stream.status).toBe(200);
        await stream.waitFor('event: subscription.omitted');
        expect(stream.received()).toContain('requires role \\"operator\\"');

        broker.emit('serve.part.started', lifecycle('another-org', 'not-yours'));
        broker.emit('serve.part.started', lifecycle(orgId, 'yours'));

        await stream.waitFor('"key":"yours"');
        await settle();
        expect(stream.received()).not.toContain('not-yours');
        stream.close();
    });

    it('refuses outright a subscription that could never deliver anything', async () => {
        const member = await subscribe('?events=serve.part.failed', memberToken);
        expect(member.status).toBe(403);
        expect(member.body).toMatch(/requires role \\?"operator\\?"/);

        const anonymous = await subscribe('?events=serve.part.failed');
        expect(anonymous.status).toBe(401);

        const unknown = await subscribe('?events=nothing.here', operatorToken);
        expect(unknown.status).toBe(403);
        expect(unknown.body).toContain('not streamed on this api');
    });

    it('delivers an event with no readable scope to nobody, operator included', async () => {
        const stream = await subscribe('?events=serve.part.started', operatorToken);
        await stream.waitFor(': open');

        // The definition says tenantId; this payload has none. A disagreement means nobody.
        broker.emit('serve.part.started', { partId: 'p-x', key: 'no-tenant', nodeID: 'events-node', tenantId: '' });
        broker.emit('serve.part.started', lifecycle(orgId, 'after'));

        await stream.waitFor('"key":"after"');
        expect(stream.received()).not.toContain('no-tenant');
        stream.close();
    });
});
