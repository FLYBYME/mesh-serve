/**
 * Password reset and email verification, against a real database: the link is queued as an email
 * job (never sent inline), only its hash is kept, it works once, a reset ends every session, and a
 * reset request answers the same whether or not the address has an account.
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
import { RESET_REQUESTED } from '../src/identity/methods/userToken.js';

const DB_NAME = 'mesh-serve-usertoken-integration-test';
const WS_PORT = 16585; // unique among the tests: 16581 was taken (nodeLabels, health) and broke them in a full run

describe('password reset and email verification', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let userId = '';
    let platformId = '';

    /** The links queued for an address, newest first, read back out of the email jobs. */
    const linksFor = async (to: string): Promise<{ template: string; token: string }[]> => {
        const jobs = await broker.call('serve.queue.find', { query: {}, limit: 100 }, { meta: { tenant_id: platformId } });
        return jobs
            .filter((j) => j.payload.to === to)
            .map((j) => {
                const vars = j.payload.vars;
                const url = typeof vars === 'object' && vars !== null && 'url' in vars && typeof vars.url === 'string' ? vars.url : '';
                return { template: String(j.payload.templateKey), token: new URL(url).searchParams.get('token') ?? '' };
            })
            .reverse();
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'usertoken-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.queue', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        const owner = await broker.call('identity.user.create', { email: 'op@reset.invalid', displayName: 'Op', roles: ['operator'], provisional: false });
        platformId = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: owner.id })).id;
        userId = (await broker.call('identity.user.register', { email: 'Ada@Reset.invalid', password: 'first-password-1234', displayName: 'Ada' })).userId;
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('an address is stored lower case, and signs in however it is typed', async () => {
        const user = await broker.call('identity.user.get', { id: userId });
        expect(user.email).toBe('ada@reset.invalid');
        await expect(broker.call('identity.ticket.issue', { email: 'ADA@Reset.Invalid', password: 'first-password-1234' }))
            .resolves.toMatchObject({ userId });
        // And the same person cannot register twice by changing the capitals.
        await expect(broker.call('identity.user.register', { email: 'ada@RESET.invalid', password: 'another-password-12', displayName: 'Ada 2' }))
            .rejects.toBeDefined();
    });

    it('a new account comes with its own organization, and owns it', async () => {
        const orgs = await broker.call('identity.organization.find', { query: { ownerId: userId } });
        expect(orgs).toHaveLength(1);
        expect(orgs[0]?.name).toBe('Ada\'s organization');
        expect(orgs[0]?.slug).toMatch(/^ada-[0-9a-f]{6}$/);
        const orgId = orgs[0]?.id ?? '';
        const members = await broker.call('identity.membership.find', { query: {} }, { meta: { user: { id: userId, tenant_id: orgId, organizationId: orgId } } });
        expect(members.map((m) => ({ userId: m.userId, roleKey: m.roleKey }))).toEqual([{ userId, roleKey: 'owner' }]);
    });

    it('registering queues a verification email, sent as the platform -- never inline', async () => {
        const links = await linksFor('ada@reset.invalid');
        expect(links.map((l) => l.template)).toEqual(['verify_email']);
        expect(links[0]?.token.length).toBeGreaterThan(40);
    });

    it('keeps only the hash of a token, never the token', async () => {
        const [link] = await linksFor('ada@reset.invalid');
        const rows = await broker.call('identity.userToken.find', { query: {}, limit: 10 });
        expect(JSON.stringify(rows)).not.toContain(link?.token ?? 'missing');
    });

    it('verifies the address once; the same link never works again', async () => {
        const [link] = await linksFor('ada@reset.invalid');
        const done = await broker.call('identity.user.verify_complete', { token: link?.token ?? '' });
        expect(done.email).toBe('ada@reset.invalid');
        const user = await broker.call('identity.user.get', { id: userId });
        expect(user.emailVerifiedAt).toBeInstanceOf(Date);
        await expect(broker.call('identity.user.verify_complete', { token: link?.token ?? '' })).rejects.toMatchObject({ status: 400 });
    });

    it('a reset request answers the same for a stranger, and sends nothing to them', async () => {
        expect(await broker.call('identity.user.reset_request', { email: 'nobody@reset.invalid' })).toEqual({ message: RESET_REQUESTED });
        expect(await linksFor('nobody@reset.invalid')).toEqual([]);
    });

    it('a reset sets the new password and ends every session; the link works once', async () => {
        const ticket = await broker.call('identity.ticket.issue', { email: 'ada@reset.invalid', password: 'first-password-1234' });
        expect(await broker.call('identity.user.reset_request', { email: ' ADA@reset.INVALID ' })).toEqual({ message: RESET_REQUESTED });
        const reset = (await linksFor('ada@reset.invalid')).find((l) => l.template === 'reset_password');
        expect(reset).toBeDefined();

        const done = await broker.call('identity.user.reset_complete', { token: reset?.token ?? '', password: 'second-password-5678' });
        // Every session Ada had -- this one and the one the sign-in test opened.
        expect(done.ok).toBe(true);
        expect(done.signedOutSessions).toBeGreaterThanOrEqual(1);

        await expect(broker.call('identity.ticket.validate', { token: ticket.token })).resolves.toMatchObject({ valid: false });
        await expect(broker.call('identity.ticket.issue', { email: 'ada@reset.invalid', password: 'first-password-1234' })).rejects.toBeDefined();
        await expect(broker.call('identity.ticket.issue', { email: 'ada@reset.invalid', password: 'second-password-5678' })).resolves.toMatchObject({ userId });
        await expect(broker.call('identity.user.reset_complete', { token: reset?.token ?? '', password: 'third-password-9012' })).rejects.toMatchObject({ status: 400 });
    });

    it('stops sending after a few requests an hour, still answering the same', async () => {
        for (let i = 0; i < 5; i++) await broker.call('identity.user.reset_request', { email: 'ada@reset.invalid' });
        const resets = (await linksFor('ada@reset.invalid')).filter((l) => l.template === 'reset_password');
        // One from the test before, and as many more as the hourly limit allows across both purposes.
        expect(resets.length).toBeLessThanOrEqual(3);
    });
});
