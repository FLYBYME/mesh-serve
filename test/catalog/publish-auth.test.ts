/**
 * B6 / F6 — who may publish.
 *
 * Tests:
 * 1. An unauthenticated call (no caller identity in meta) is refused with 401 caller_unknown.
 * 2. First publish: an authenticated caller claims an unused part name and the publisher is
 *    permanently bound to the caller's tenant_id.
 * 3. Subsequent publishes by the owning publisher succeed.
 * 4. A publish of an existing part by a different publisher is refused with 404 part_not_found
 *    (matching builder.build_start — probing reveals nothing).
 * 5. A caller passing a mismatched input.publisher is refused with 404 part_not_found.
 * 6. Oracle prevention: probing a non-existent part with a mismatched publisher and an existing
 *    part owned by another org answer with the identical 404 error code and message.
 */

import {
    BrokerModule, DatabaseModule, MeshApp, RegistryModule, type IServiceBroker,
} from '@flybyme/mesh';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CatalogService } from '../../src/catalog/catalog.service.js';

const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!reachable)('B6: catalog.publish identity and ownership', () => {
    let client: MongoClient;
    let dbName: string;
    let app: MeshApp;
    let broker: IServiceBroker;

    const ORG_A = 'org-tenant-alpha';
    const ORG_B = 'org-tenant-beta';

    const metaA = { meta: { user: { id: 'user-a', tenant_id: ORG_A } } };
    const metaB = { meta: { user: { id: 'user-b', tenant_id: ORG_B } } };

    beforeAll(async () => {
        dbName = `mesh-serve-pub-test-${String(Date.now())}`;
        client = new MongoClient(MONGO);
        await client.connect();

        app = new MeshApp({
            nodeID: `pub-node-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-serve-publish-test',
        });

        app.use(new RegistryModule());
        app.use(new DatabaseModule({ uri: MONGO, dbName }));
        app.use(new BrokerModule());
        await app.start();

        await app.registerModule(new CatalogService());
        broker = app.getProvider<IServiceBroker>('broker');
    });

    afterAll(async () => {
        await app?.stop();
        if (client) {
            await client.db(dbName).dropDatabase();
            await client.close();
        }
    });

    it('refuses publishing with no caller credential (401 caller_unknown)', async () => {
        await expect(
            broker.call('catalog.publish', {
                name: 'part-unauth',
                kind: 'application',
                repository: 'https://github.com/example/repo',
                version: '1.0.0',
                commit: 'a'.repeat(40),
                entry: 'src/index.ts',
            }),
        ).rejects.toMatchObject({
            code: 'caller_unknown',
            status: 401,
        });
    });

    it('first publish permanently binds publisher to caller identity', async () => {
        // No explicit type argument: `call`'s first type parameter is the *tool name*, keyed off
        // `IServiceToolRegistry`, so the return type comes from the contract rather than from a
        // shape written out here. Restating it would be a second copy that can drift.
        const published = await broker.call(
            'catalog.publish',
            {
                name: 'first-part',
                kind: 'extension',
                repository: 'https://github.com/example/first',
                version: '1.0.0',
                commit: 'a'.repeat(40),
                entry: 'src/index.ts',
            },
            metaA,
        );

        expect(published.existed).toBe(false);

        // Verify part record has publisher bound to ORG_A
        const part = await broker.call(
            'part.find_one',
            { query: { name: 'first-part' } },
        );
        // `find_one` returns `T | undefined` by design — a miss is a value, not a throw — so the
        // narrowing is real rather than ceremony.
        if (part === undefined) throw new Error('first-part was not written');
        expect(part.publisher).toBe(ORG_A);
    });

    it('subsequent publish by the same publisher succeeds', async () => {
        const published = await broker.call(
            'catalog.publish',
            {
                name: 'first-part',
                kind: 'extension',
                repository: 'https://github.com/example/first',
                version: '1.1.0',
                commit: 'b'.repeat(40),
                entry: 'src/index.ts',
            },
            metaA,
        );

        expect(published.existed).toBe(false);
    });

    it('publish of existing part by a different organization is refused with 404 part_not_found', async () => {
        await expect(
            broker.call(
                'catalog.publish',
                {
                    name: 'first-part',
                    kind: 'extension',
                    repository: 'https://github.com/attacker/repo',
                    version: '2.0.0',
                    commit: 'c'.repeat(40),
                    entry: 'src/index.ts',
                },
                metaB,
            ),
        ).rejects.toMatchObject({
            code: 'part_not_found',
            status: 404,
            message: 'No such part.',
        });
    });

    it('caller asserting a mismatched publisher in input is refused with 404 part_not_found', async () => {
        // Caller is ORG_A, but input asserts publisher is ORG_B
        await expect(
            broker.call(
                'catalog.publish',
                {
                    name: 'claimed-part',
                    kind: 'extension',
                    repository: 'https://github.com/example/claimed',
                    publisher: ORG_B,
                    version: '1.0.0',
                    commit: 'd'.repeat(40),
                    entry: 'src/index.ts',
                },
                metaA,
            ),
        ).rejects.toMatchObject({
            code: 'part_not_found',
            status: 404,
            message: 'No such part.',
        });
    });

    it('prevents account enumeration / probing oracle', async () => {
        // Probe non-existent part with mismatched publisher
        const errorNonExistent = await broker.call(
            'catalog.publish',
            {
                name: 'non-existent-part',
                kind: 'extension',
                repository: 'https://github.com/probe/probe',
                publisher: ORG_B,
                version: '1.0.0',
                commit: 'e'.repeat(40),
                entry: 'src/index.ts',
            },
            metaA,
        ).catch((err: unknown) => err);

        // Probe existing part owned by ORG_A with caller ORG_B
        const errorExistingOther = await broker.call(
            'catalog.publish',
            {
                name: 'first-part',
                kind: 'extension',
                repository: 'https://github.com/probe/probe',
                version: '3.0.0',
                commit: 'f'.repeat(40),
                entry: 'src/index.ts',
            },
            metaB,
        ).catch((err: unknown) => err);

        expect(errorNonExistent).toMatchObject({
            code: 'part_not_found',
            status: 404,
            message: 'No such part.',
        });
        expect(errorExistingOther).toMatchObject({
            code: 'part_not_found',
            status: 404,
            message: 'No such part.',
        });
    });
});
