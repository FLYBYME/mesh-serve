/**
 * identity.membership.assign, on a real broker and database: the caller must be an admin or owner of
 * the organization named (an operator may act anywhere), and only an owner gives or takes owner.
 * Before this, it acted on whatever organizationId it was given (open.md 1939).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import {
    BrokerModule, DatabaseModule, defaultPrint, defineContract, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/identity.contract.js';

/** A stand-in for an application's seat limit (SurfDNS's is billing.check). */
const seatsContract = defineContract({
    domain: 'seatstest', action: 'check', description: 'test: may this organization have one more person',
    inputSchema: z.object({ resource: z.string(), current: z.number(), adding: z.number() }),
    outputSchema: z.object({ allowed: z.boolean(), why: z.string().optional() }),
    rest: { method: 'POST', path: '/seatstest/check' }, filePath: 'test/membershipAssign.integration.test.ts',
    concurrency: 'on-demand', permissions: [], visibility: 'internal', print: defaultPrint,
});

const DB_NAME = 'mesh-serve-membership-assign-test';
// Its own port: 16613 is mcp.integration's, and the two collided when run at once.
const WS_PORT = 16622;

describe('identity.membership.assign: only in an organization the caller runs', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let opId = '';
    let platformId = '';
    let aliceId = '';
    let bobId = '';
    let carolId = '';
    let daveId = '';
    let orgA = '';
    let orgB = '';

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = new MeshApp({ nodeID: 'membership-assign-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        const op = await broker.call('identity.user.create', { email: 'op@assign.invalid', displayName: 'Op', roles: ['operator'], provisional: false });
        opId = op.id;
        const platform = await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: opId });
        platformId = platform.id;

        // Alice owns A; Bob is an admin of A; Carol owns B; Dave is a member of A.
        const alice = await broker.call('identity.user.create', { email: 'alice@assign.invalid', displayName: 'Alice', roles: [], provisional: false });
        const bob = await broker.call('identity.user.create', { email: 'bob@assign.invalid', displayName: 'Bob', roles: [], provisional: false });
        const carol = await broker.call('identity.user.create', { email: 'carol@assign.invalid', displayName: 'Carol', roles: [], provisional: false });
        const dave = await broker.call('identity.user.create', { email: 'dave@assign.invalid', displayName: 'Dave', roles: [], provisional: false });
        aliceId = alice.id;
        bobId = bob.id;
        carolId = carol.id;
        daveId = dave.id;

        const a = await broker.call('identity.organization.create', { slug: 'org-a', name: 'Org A', ownerId: aliceId });
        const b = await broker.call('identity.organization.create', { slug: 'org-b', name: 'Org B', ownerId: carolId });
        orgA = a.id;
        orgB = b.id;

        await broker.call('identity.membership.assign', { userId: bobId, organizationId: orgA, roleKey: 'admin' }, as(opId, platformId));
        await broker.call('identity.membership.assign', { userId: daveId, organizationId: orgA, roleKey: 'member' }, as(opId, platformId));
    }, 40000);

    afterAll(async () => {
        await app.stop();

        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    /** A call as one account, its own organization the one it signed in to. */
    const as = (userId: string, tenantId: string): { meta: { user: { id: string; tenant_id: string } } } => ({ meta: { user: { id: userId, tenant_id: tenantId } } });

    const roleIn = async (userId: string, organizationId: string): Promise<string | null> => {
        const rows = await broker.call('identity.membership.find', { query: { userId, organizationId } }, { meta: { user: { id: opId, tenant_id: organizationId, organizationId } } });

        return rows[0]?.roleKey ?? null;
    };

    it('an admin of A cannot assign in B: refused, nothing written', async () => {
        await expect(broker.call('identity.membership.assign', { userId: daveId, organizationId: orgB, roleKey: 'admin' }, as(bobId, orgA)))
            .rejects.toMatchObject({ status: 403 });

        expect(await roleIn(daveId, orgB)).toBeNull();
    });

    it('a member of A cannot assign in A', async () => {
        await expect(broker.call('identity.membership.assign', { userId: carolId, organizationId: orgA, roleKey: 'member' }, as(daveId, orgA)))
            .rejects.toMatchObject({ status: 403 });

        expect(await roleIn(carolId, orgA)).toBeNull();
    });

    it('an admin of A adds a member to A, but cannot give owner', async () => {
        const added = await broker.call('identity.membership.assign', { userId: carolId, organizationId: orgA, roleKey: 'member' }, as(bobId, orgA));
        expect(added.changed).toBe(true);

        await expect(broker.call('identity.membership.assign', { userId: daveId, organizationId: orgA, roleKey: 'owner' }, as(bobId, orgA)))
            .rejects.toMatchObject({ status: 403 });
        expect(await roleIn(daveId, orgA)).toBe('member');
    });

    it('an admin of A cannot take an owner\'s role away', async () => {
        await expect(broker.call('identity.membership.assign', { userId: aliceId, organizationId: orgA, roleKey: 'member' }, as(bobId, orgA)))
            .rejects.toMatchObject({ status: 403 });

        expect(await roleIn(aliceId, orgA)).toBe('owner');
    });

    it('an owner of A gives owner; the last-owner rule still holds', async () => {
        const made = await broker.call('identity.membership.assign', { userId: daveId, organizationId: orgA, roleKey: 'owner' }, as(aliceId, orgA));
        expect(made.roleKey).toBe('owner');

        await broker.call('identity.membership.assign', { userId: daveId, organizationId: orgA, roleKey: 'member' }, as(aliceId, orgA));
        await expect(broker.call('identity.membership.assign', { userId: aliceId, organizationId: orgA, roleKey: 'member' }, as(aliceId, orgA)))
            .rejects.toThrow('only owner');
    });

    it('an operator may assign in any organization', async () => {
        const made = await broker.call('identity.membership.assign', { userId: daveId, organizationId: orgB, roleKey: 'member' }, as(opId, platformId));

        expect(made.changed).toBe(true);
        expect(await roleIn(daveId, orgB)).toBe('member');
    });

    it('asks IDENTITY_ADMIT_CONTRACT before someone joins: past the limit, refused before anything is made', async () => {
        // B has Carol (owner) and Dave: a stand-in limit of three people.
        const asked: { tenant: string; current: number }[] = [];
        broker.registerContract(seatsContract, async (input, ctx) => {
            const user = ctx.meta?.user;
            const tenant = typeof user === 'object' && user !== null ? Reflect.get(user, 'tenant_id') : undefined;
            asked.push({ tenant: typeof tenant === 'string' ? tenant : '', current: input.current });
            const allowed = input.current + input.adding <= 3;

            return allowed ? { allowed } : { allowed, why: 'Your plan allows 3 people.' };
        });
        process.env.IDENTITY_ADMIT_CONTRACT = 'seatstest.check';

        try {
            const erin = await broker.call('identity.user.create', { email: 'erin@assign.invalid', displayName: 'Erin', roles: [], provisional: false });
            const frank = await broker.call('identity.user.create', { email: 'frank@assign.invalid', displayName: 'Frank', roles: [], provisional: false });
            await broker.call('identity.user.update', { id: carolId, emailVerifiedAt: new Date() }, as(opId, platformId));

            const added = await broker.call('identity.membership.assign', { userId: erin.id, organizationId: orgB, roleKey: 'member' }, as(carolId, orgB));
            expect(added.changed).toBe(true);
            expect(asked).toEqual([{ tenant: orgB, current: 2 }]);

            await expect(broker.call('identity.membership.assign', { userId: frank.id, organizationId: orgB, roleKey: 'member' }, as(carolId, orgB)))
                .rejects.toMatchObject({ status: 402, message: 'Your plan allows 3 people.' });
            expect(await roleIn(frank.id, orgB)).toBeNull();

            // An invite to a new address is refused before its account is made.
            await expect(broker.call('identity.membership.invite', { email: 'ghost@assign.invalid', roleKey: 'member' }, as(carolId, orgB)))
                .rejects.toMatchObject({ status: 402 });
            const ghosts = await broker.call('identity.user.find', { query: { email: 'ghost@assign.invalid' } }, as(opId, platformId));
            expect(ghosts).toHaveLength(0);

            // An operator places anyone, and isn't asked.
            const before = asked.length;
            await broker.call('identity.membership.assign', { userId: frank.id, organizationId: orgB, roleKey: 'member' }, as(opId, platformId));
            expect(await roleIn(frank.id, orgB)).toBe('member');
            expect(asked).toHaveLength(before);
        } finally {
            delete process.env.IDENTITY_ADMIT_CONTRACT;
            await broker.unregisterContract('seatstest.check');
        }
    });
});
