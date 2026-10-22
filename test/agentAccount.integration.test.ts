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
import { agentRevokeContract, agentTokenContract } from '../src/identity/contracts/agent.contract.js';
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

    it('an operator calling from another organization issues its token (the gateway\'s meta names the operator\'s own organization)', async () => {
        // As the api's gateway calls: the operator's own organization in user.organizationId as well.
        const fromElsewhere = { meta: { user: { id: operatorId, tenant_id: otherOrgId, organizationId: otherOrgId } } };
        const agent = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'remote' }, fromElsewhere);

        const issued = await broker.call('identity.apiToken.issue', { name: 'dev-elsewhere', userId: agent.userId, organizationId: orgId, roles: ['agent'] }, fromElsewhere);

        expect(issued).toMatchObject({ userId: agent.userId, roles: ['agent'] });
    });

    it('never takes over an address that is not its organization\'s agent', async () => {
        await broker.call('identity.user.create', { email: agentEmail(otherOrgId, 'leader'), displayName: 'Squatter', roles: [], provisional: false });
        await expect(broker.call('identity.agent.ensure', { organizationId: otherOrgId, name: 'leader' }, asOperator())).rejects.toThrow(/not .*agent account/);
    });

    it('a service asks a token for an agent account, never a person\'s: the earlier one stops working', async () => {
        // As a service in the mesh asks, with no operator behind it (an order being set up).
        const asService = { meta: { user: { id: 'builds', tenant_id: otherOrgId } } };
        const agent = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'dev' }, asOperator());

        const first = await broker.call('identity.agent.token', { organizationId: orgId, name: 'dev', tokenName: 'dev-git' }, asService);
        expect(first).toMatchObject({ userId: agent.userId, roles: ['agent'], revoked: 0 });
        expect(await broker.call('identity.apiToken.validate', { token: first.token })).toMatchObject({ valid: true, userId: agent.userId, organizationId: orgId });

        const second = await broker.call('identity.agent.token', { organizationId: orgId, name: 'dev', tokenName: 'dev-git' }, asService);
        expect(second.revoked).toBe(1);
        expect(await broker.call('identity.apiToken.validate', { token: first.token })).toMatchObject({ valid: false });

        // An account at an agent's address that is a person's, or an agent never made: refused.
        await expect(broker.call('identity.agent.token', { organizationId: otherOrgId, name: 'leader', tokenName: 'x' }, asService)).rejects.toThrow(/No agent/);
        await expect(broker.call('identity.agent.token', { organizationId: orgId, name: 'ghost', tokenName: 'x' }, asService)).rejects.toThrow(/No agent/);
    });

    it('a service with no role of its own makes its organization\'s agent (workflows\' ci agent, 10-21)', async () => {
        const asService = { meta: { user: { id: 'workflows', tenant_id: orgId } } };
        const made = await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'ci' }, asService);
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'agent', organizationId: orgId }, asOperator())).toMatchObject({ granted: true });
        expect((await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'ci' }, asService)).created).toBe(false);
    });

    it('a job\'s token lasts the job: it expires on its own, and its service revokes it when the job ends', async () => {
        const asService = { meta: { user: { id: 'workflows', tenant_id: orgId } } };
        await broker.call('identity.agent.ensure', { organizationId: orgId, name: 'ci' }, asService);

        const short = await broker.call('identity.agent.token', { organizationId: orgId, name: 'ci', tokenName: 'job-short', expiresInMs: 1 }, asService);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await broker.call('identity.apiToken.validate', { token: short.token })).toMatchObject({ valid: false });

        const job = await broker.call('identity.agent.token', { organizationId: orgId, name: 'ci', tokenName: 'job-1', expiresInMs: 60_000 }, asService);
        expect(await broker.call('identity.apiToken.validate', { token: job.token })).toMatchObject({ valid: true, name: 'job-1' });

        expect(await broker.call('identity.agent.revoke', { organizationId: orgId, name: 'ci', tokenName: 'job-1' }, asService)).toEqual({ revoked: 1 });
        expect(await broker.call('identity.apiToken.validate', { token: job.token })).toMatchObject({ valid: false });
        expect(await broker.call('identity.agent.revoke', { organizationId: orgId, name: 'ci', tokenName: 'job-1' }, asService)).toEqual({ revoked: 0 });

        // Never a person's token, whatever its name.
        expect(await broker.call('identity.agent.revoke', { organizationId: otherOrgId, name: 'leader', tokenName: 'job-1' }, asService)).toEqual({ revoked: 0 });
    });

    it('an organization\'s admin makes its own agent, as a member of that organization, and gets its token (Peera, 10-22)', async () => {
        // As the api's gateway calls for an admin of orgId: the call's organization is theirs.
        const asAdmin = { meta: { user: { id: 'admin-of-father-tom', tenant_id: orgId, organizationId: orgId } } };

        const made = await broker.call('identity.agent.save', { name: 'peera', displayName: 'Peera' }, asAdmin);
        expect(made).toMatchObject({ organizationId: orgId, name: 'peera', email: agentEmail(orgId, 'peera'), role: 'member', created: true });
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'member', organizationId: orgId }, asOperator())).toMatchObject({ granted: true });
        // Never more than a member, and nothing in another organization.
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'admin', organizationId: orgId }, asOperator())).toMatchObject({ granted: false });
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'member', organizationId: otherOrgId }, asOperator())).toMatchObject({ granted: false });

        const issued = await broker.call('identity.agent.issue', { name: 'peera', tokenName: 'peera-bridge' }, asAdmin);
        expect(issued).toMatchObject({ userId: made.userId, roles: ['member'], revoked: 0 });
        const checked = await broker.call('identity.apiToken.validate', { token: issued.token });
        expect(checked).toMatchObject({ valid: true, userId: made.userId, organizationId: orgId });

        // Its organization lists it, with its role; another organization does not.
        expect(await broker.call('identity.agent.find', {}, asAdmin)).toEqual(expect.arrayContaining([
            expect.objectContaining({ userId: made.userId, name: 'peera', displayName: 'Peera', role: 'member' }),
        ]));
        const elsewhere = await broker.call('identity.agent.find', {}, { meta: { user: { id: 'x', tenant_id: otherOrgId, organizationId: otherOrgId } } });
        expect(elsewhere.some((a) => a.userId === made.userId)).toBe(false);

        // Its role is the admin's to change, both ways; the account stays the same.
        const narrowed = await broker.call('identity.agent.save', { name: 'peera', role: 'agent' }, asAdmin);
        expect(narrowed).toMatchObject({ userId: made.userId, role: 'agent', created: false });
        expect(await broker.call('identity.hasRole', { userId: made.userId, role: 'member', organizationId: orgId }, asOperator())).toMatchObject({ granted: false });
    });

    it('an admin\'s agent is always their own organization\'s: the organization is the call\'s, never an input', async () => {
        const asAdmin = { meta: { user: { id: 'admin-of-father-tom', tenant_id: orgId, organizationId: orgId } } };

        await expect(broker.callNamed('identity.agent.save', { name: 'x', organizationId: otherOrgId }, asAdmin)).rejects.toThrow(/organizationId/);
        await expect(broker.callNamed('identity.agent.save', { name: 'x', role: 'admin' }, asAdmin)).rejects.toThrow(/role/);
        // Another organization's agent is not theirs to issue for.
        await broker.call('identity.agent.ensure', { organizationId: otherOrgId, name: 'helper' }, asOperator());
        await expect(broker.call('identity.agent.issue', { name: 'helper', tokenName: 't' }, asAdmin)).rejects.toThrow(/No agent/);
        // A person's address is never taken over.
        await expect(broker.call('identity.agent.save', { name: 'leader' }, { meta: { user: { id: 'a', tenant_id: otherOrgId, organizationId: otherOrgId } } })).rejects.toThrow(/not .*agent account/);
    });

    it('is internal: no api can expose it', () => {
        expect(agentTokenContract.visibility).toBe('internal');
        expect(agentRevokeContract.visibility).toBe('internal');
    });
});
