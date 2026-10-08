/**
 * identity.organization.remove, against a real database: a throwaway organization goes with its
 * memberships, its people's accounts stay, and the platform's own organization is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';
import '../src/identity/contracts/userToken.contract.js';
import '../src/queue/contracts/queue.contract.js';

const DB_NAME = 'mesh-serve-organization-remove-test';
const WS_PORT = 16603;

describe('identity.organization.remove', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let ownerId = '';
    let platformId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'org-remove-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.queue', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        const owner = await broker.call('identity.user.create', { email: 'op@remove.invalid', displayName: 'Op', roles: ['operator'], provisional: false });
        ownerId = owner.id;
        platformId = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId })).id;
    }, 40000);

    afterAll(async () => {
        await app.stop();

        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    const operator = (): { meta: { user: { id: string; tenant_id: string } } } => ({ meta: { user: { id: ownerId, tenant_id: platformId } } });

    it('removes a throwaway organization with its memberships; the accounts stay', async () => {
        const tester = await broker.call('identity.user.create', { email: 'rehearsal@remove.invalid', displayName: 'Rehearsal', roles: [], provisional: false });
        const throwaway = await broker.call('identity.organization.create', { slug: 'rehearsal-1', name: 'Rehearsal 1', ownerId: tester.id });

        const removed = await broker.call('identity.organization.remove', { organizationId: throwaway.id }, operator());

        expect(removed).toEqual({ organizationId: throwaway.id, name: 'Rehearsal 1', memberships: 1 });
        expect(await broker.call('identity.organization.find', { query: { slug: 'rehearsal-1' } }, operator())).toHaveLength(0);
        expect(await broker.call('identity.user.find', { query: { id: tester.id } }, operator())).toHaveLength(1);
    });

    it('refuses the platform\'s own organization', async () => {
        await expect(broker.call('identity.organization.remove', { organizationId: platformId }, operator())).rejects.toThrow('cannot be removed');
    });

    it('says when there is no such organization', async () => {
        await expect(broker.call('identity.organization.remove', { organizationId: 'no-such-org' }, operator())).rejects.toThrow('No organization');
    });
});

/**
 * identity.user.remove, on the same database: a bot's sign-up goes with what lets it act; an owner,
 * a platform role holder and the caller themself are refused.
 */
describe('identity.user.remove', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let opId = '';
    let platformId = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        app = new MeshApp({ nodeID: 'user-remove-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT + 1, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: `${DB_NAME}-user` }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.queue', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        opId = (await broker.call('identity.user.create', { email: 'op@user-remove.invalid', displayName: 'Op', roles: ['operator'], provisional: false })).id;
        platformId = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: opId })).id;
    }, 40000);

    afterAll(async () => {
        await app.stop();

        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(`${DB_NAME}-user`).dropDatabase();
        await client.close();
    });

    const operator = (): { meta: { user: { id: string; tenant_id: string } } } => ({ meta: { user: { id: opId, tenant_id: platformId } } });

    it('removes a bot\'s account with its memberships, sign-ins, tokens and links, once its organization is gone', async () => {
        const bot = await broker.call('identity.user.create', { email: 'bot@user-remove.invalid', displayName: 'joVIGHoFvVmssLPZApxFntaH', roles: [], provisional: false });
        const org = await broker.call('identity.organization.create', { slug: 'bot-org', name: 'Bot org', ownerId: bot.id });
        // A membership elsewhere too, as a person invited into another organization has.
        await broker.call('identity.membership.assign', { userId: bot.id, organizationId: platformId, roleKey: 'member' }, operator());
        await broker.call('identity.ticket.create', { token: 'bot-ticket', userId: bot.id, roles: [], issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), via: 'login' });

        await expect(broker.call('identity.user.remove', { userId: bot.id }, operator())).rejects.toThrow('owns Bot org');
        await broker.call('identity.organization.remove', { organizationId: org.id }, operator());

        const removed = await broker.call('identity.user.remove', { userId: bot.id }, operator());

        expect(removed).toEqual({ userId: bot.id, email: 'bot@user-remove.invalid', memberships: 1, sessions: 1, apiTokens: 0, links: 0 });
        expect(await broker.call('identity.user.find', { query: { id: bot.id } }, operator())).toHaveLength(0);
        expect(await broker.call('identity.ticket.find', { query: { userId: bot.id } })).toHaveLength(0);
    });

    it('refuses a platform role holder and the caller\'s own account', async () => {
        const helper = await broker.call('identity.user.create', { email: 'helper@user-remove.invalid', displayName: 'Helper', roles: ['operator'], provisional: false });

        await expect(broker.call('identity.user.remove', { userId: helper.id }, operator())).rejects.toThrow('take it away first');
        await expect(broker.call('identity.user.remove', { userId: opId }, operator())).rejects.toThrow('your own account');
        await expect(broker.call('identity.user.remove', { userId: 'no-such-user' }, operator())).rejects.toThrow('No account');
    });
});
