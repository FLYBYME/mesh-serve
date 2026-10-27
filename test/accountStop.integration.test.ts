/**
 * Suspending an account stops what it holds, and a password change ends its sessions (review
 * 10-26): before, a suspended account's tickets and api tokens kept working until they expired,
 * and a session made with the old password outlived the change.
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
import '../src/identity/contracts/userToken.contract.js';
import '../src/identity/contracts/identity.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';

const DB_NAME = 'mesh-serve-account-stop-integration-test';
const WS_PORT = 16614;
const PASSWORD = 'a-real-password-for-tests-14';

describe('a stopped account stops what it holds', () => {
    let app: MeshApp;
    let broker: IServiceBroker;

    const account = async (email: string): Promise<{ userId: string; ticket: string; apiToken: string }> => {
        const userId = (await broker.call('identity.user.create', {
            email, displayName: email, passwordHash: await hashPassword(PASSWORD), roles: [], provisional: false,
        })).id;
        const ticket = (await broker.call('identity.ticket.issue', { email, password: PASSWORD })).token;
        const apiToken = (await broker.call('identity.apiToken.issue', { name: 'ci', userId }, { meta: { user: { id: userId, tenant_id: '' } } })).token;
        return { userId, ticket, apiToken };
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'account-stop-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('suspending an account stops its tickets and api tokens at once', async () => {
        const held = await account('suspended@stop.invalid');
        expect((await broker.call('identity.ticket.validate', { token: held.ticket })).valid).toBe(true);
        expect((await broker.call('identity.apiToken.validate', { token: held.apiToken })).valid).toBe(true);

        await broker.call('identity.user.update', { id: held.userId, suspendedAt: new Date() });

        expect((await broker.call('identity.ticket.validate', { token: held.ticket })).valid).toBe(false);
        expect((await broker.call('identity.apiToken.validate', { token: held.apiToken })).valid).toBe(false);
    });

    it('changing a password ends the sessions made with the old one', async () => {
        const held = await account('changed@stop.invalid');

        await broker.call('identity.user.setPassword', { password: 'a-new-password-for-tests-15', currentPassword: PASSWORD }, { meta: { user: { id: held.userId, tenant_id: '' } } });

        expect((await broker.call('identity.ticket.validate', { token: held.ticket })).valid).toBe(false);
        expect((await broker.call('identity.apiToken.validate', { token: held.apiToken })).valid).toBe(true);
    });
});
