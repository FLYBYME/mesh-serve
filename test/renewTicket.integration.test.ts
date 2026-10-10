import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import type { Database, IServiceBroker, MeshApp } from '@flybyme/mesh';
import { createTestNode } from '@flybyme/mesh/node';

import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import { hashPassword, hashToken } from '../src/identity/methods/hash.js';
import { RENEW_FOR_MS } from '../src/identity/tools/renewTicket.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/role.contract.js';

const DB_NAME = 'mesh-serve-renew-ticket-test';
const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const PASSWORD = 'correct horse battery';

/**
 * identity.ticket.renew (owner, 10-10: "does the api allow token renew? it should"): a valid ticket
 * for a fresh one, the old one revoked; never past 30 days from the password.
 */
describe('identity.ticket.renew', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let db: Database;

    const signIn = (): Promise<{ token: string; userId: string; expiresAt: number }> =>
        broker.call('identity.ticket.issue', { email: 'renew@test.invalid', password: PASSWORD });
    const isValid = async (token: string): Promise<boolean> => {
        const answer = await broker.call('identity.ticket.validate', { token });

        return answer.valid;
    };

    beforeAll(async () => {
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();

        app = await createTestNode({ nodeID: 'renew-ticket-node', port: 16591, dbName: DB_NAME });
        broker = app.getProvider<IServiceBroker>('broker');
        db = app.getProvider<Database>('database');
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});

        await broker.call('identity.user.create', {
            email: 'renew@test.invalid', displayName: 'Renew', roles: [], provisional: false, passwordHash: await hashPassword(PASSWORD),
        });
    });

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('gives a fresh ticket for 24 hours more; the old one stops working at once', async () => {
        const first = await signIn();

        const renewed = await broker.call('identity.ticket.renew', { token: first.token });

        expect(renewed.token).not.toBe(first.token);
        expect(renewed.userId).toBe(first.userId);
        expect(renewed.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
        expect(await isValid(renewed.token)).toBe(true);
        expect(await isValid(first.token)).toBe(false);

        // The old one cannot be renewed again: only one of the two ever works.
        await expect(broker.call('identity.ticket.renew', { token: first.token })).rejects.toMatchObject({ code: 'TICKET_INVALID', status: 401 });
    });

    it('keeps the sign-in time, and stops 30 days after the password: then sign in again', async () => {
        const first = await signIn();
        const renewed = await broker.call('identity.ticket.renew', { token: first.token });

        const before = await db.collection('identity.ticket').findOne({ token: hashToken(first.token) });
        const after = await db.collection('identity.ticket').findOne({ token: hashToken(renewed.token) });
        expect(after?.signedInAt?.getTime()).toBe(before?.signedInAt?.getTime());
        expect(after?.via).toBe('renew');

        // Signed in 29 days and 23 hours ago: renewed, but only until the 30 days end.
        const nearlyDone = new Date(Date.now() - RENEW_FOR_MS + 60 * 60 * 1000);
        if (after === undefined) throw new Error('no renewed ticket');
        await db.collection('identity.ticket').update(after.id, { signedInAt: nearlyDone });
        const last = await broker.call('identity.ticket.renew', { token: renewed.token });
        expect(last.expiresAt).toBe(nearlyDone.getTime() + RENEW_FOR_MS);

        // Past the 30 days: refused.
        const lastRow = await db.collection('identity.ticket').findOne({ token: hashToken(last.token) });
        if (lastRow === undefined) throw new Error('no last ticket');
        await db.collection('identity.ticket').update(lastRow.id, { signedInAt: new Date(Date.now() - RENEW_FOR_MS - 1000) });
        await expect(broker.call('identity.ticket.renew', { token: last.token })).rejects.toMatchObject({ code: 'SIGN_IN_AGAIN', status: 401 });
    });

    it('refuses a ticket that does not exist', async () => {
        await expect(broker.call('identity.ticket.renew', { token: 'not-a-ticket' })).rejects.toMatchObject({ code: 'TICKET_INVALID', status: 401 });
    });
});
