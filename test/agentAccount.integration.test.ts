/**
 * An organization's agent account, against a real database: made once and found after, a member of
 * that organization only with the agent role (which admits no member call), no password and no way
 * to get one, and tokens of its own -- so what it may do is what its account may do, never a
 * person's.
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
import '../src/identity/contracts/agent.contract.js';
import '../src/queue/contracts/queue.contract.js';
import { agentEmail } from '../src/identity/tools/ensureAgent.js';

const DB_NAME = 'mesh-serve-agent-account-test';
const WS_PORT = 16587;

describe('agent accounts', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let operatorId = '';
    let orgId = '';
    let otherOrgId = '';

    const asOperator = () => ({ meta: { user: { id: operatorId, tenant_id: orgId } } });

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'agent-account-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.queue', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        const op = await broker.call('identity.user.create', { email: 'op@agents.invalid', displayName: 'Op', roles: ['operator'], provisional: false });
        operatorId = op.id;
        orgId = (await broker.call('identity.organization.create', { slug: 'father-tom', name: 'Father Tom', ownerId: op.id })).id;
        otherOrgId = (await broker.call('identity.organization.create', { slug: 'bettys-nails', name: "Betty's Nails", ownerId: op.id })).id;
    }, 40000);

    afterAll(async () => {
        await app?.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('is made once, found after, and is a member of its organization only, as an agent', async () => {
        const made = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'dev' }, asOperator());
        expect(made).toMatchObject({ organizationId: orgId, name: 'dev', email: agentEmail(orgId, 'dev'), created: true });

        const again = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'dev' }, asOperator());
        expect(again).toMatchObject({ userId: made.userId, created: false });

        const user = (await broker.call('identity.user.find', { query: { id: made.userId } }, asOperator()))[0];
        expect(user).toMatchObject({ kind: 'agent', agentOf: orgId, roles: [] });
        expect(user?.passwordHash).toBeUndefined();

        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'agent', organizationId: orgId }, asOperator())).toMatchObject({ granted: true });
        // The agent role inherits nothing: an exposure for members does not admit it.
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'member', organizationId: orgId }, asOperator())).toMatchObject({ granted: false });
        // And nothing in another organization.
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'agent', organizationId: otherOrgId }, asOperator())).toMatchObject({ granted: false });

        // Each organization's dev agent is its own account.
        const theirs = await broker.call('identity.agent.ensure', { organizationId: otherOrgId, name: 'dev' }, asOperator());
        expect(theirs.userId).not.toBe(made.userId);
    });

    it('never signs in and can never be given a password', async () => {
        const agent = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'dev' }, asOperator());

        await expect(broker.call('identity.ticket.issue', { email: agent.email, password: 'anything-at-all-1234' })).rejects.toThrow();
        await expect(broker.call('identity.user.setPassword', { password: 'a-new-password-1234' }, { meta: { user: { id: agent.userId, tenant_id: orgId } } }))
            .rejects.toThrow(/agent account has no password/);
    });

    it('acts by its own tokens, scoped to its organization', async () => {
        const agent = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'dev' }, asOperator());

        const issued = await broker.call('identity.apiToken.issue', { name: 'dev-workspace', userId: agent.userId, organizationId: orgId, roles: ['agent'] }, asOperator());
        expect(issued).toMatchObject({ userId: agent.userId, roles: ['agent'] });

        const checked = await broker.call('identity.apiToken.validate', { token: issued.token });
        expect(checked).toMatchObject({ valid: true, userId: agent.userId, organizationId: orgId });

        // Not a role it does not hold, and not another organization's.
        await expect(broker.call('identity.apiToken.issue', { name: 'x', userId: agent.userId, organizationId: orgId, roles: ['member'] }, asOperator())).rejects.toThrow(/not held/);
        await expect(broker.call('identity.apiToken.issue', { name: 'y', userId: agent.userId, organizationId: otherOrgId }, asOperator())).rejects.toThrow(/belongs to/);
    });

    it('never takes over an address that is not its organization\'s agent', async () => {
        await broker.call('identity.user.create', { email: agentEmail(otherOrgId, 'leader'), displayName: 'Squatter', roles: [], provisional: false });
        await expect(broker.call('identity.agent.ensure', { organizationId: otherOrgId, name: 'leader' }, asOperator())).rejects.toThrow(/not .*agent account/);
    });
});
