/**
 * **F6: CLI API token credential and publisher scope derivation.**
 *
 * Assertions:
 * 1. `mesh-serve publish` works end to end, with a token, against the running node.
 * 2. A publish with no credential is refused, naming what is missing (MESH_TOKEN).
 * 3. A token belonging to organization A cannot publish organization B's part — 404 part_not_found, matching build_start.
 * 4. A token supplied via MESH_TOKEN environment variable publishes successfully end to end.
 * 5. An asserted `--publisher` that disagrees with the token's organization is refused.
 * 6. A user-scoped token (no explicit organizationId on token) resolves publisher scope from memberships.
 *
 * Needs mongo on `MONGODB_URI` (default `mongodb://localhost:27017`). Skipped when unreachable.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
    type Database, type IServiceBroker,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { MongoClient } from 'mongodb';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { run_ } from '../../src/api/publish-cli.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { createIdentityModule, mongoStore } from '../../src/identity/index.js';

const run = promisify(execFile);
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

async function makeFixtureRepo(partId: string, version = '1.0.0'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `mesh-fixture-${partId}-`));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/index.ts'), 'export const hello = "world";\n');
    await writeFile(join(dir, 'mesh.json'), JSON.stringify({
        parts: [{ kind: 'application', id: partId, version, entry: 'src/index.ts' }],
    }, null, 2));

    await run('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await run('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await run('git', ['remote', 'add', 'origin', `https://github.com/example/${partId}.git`], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '--quiet', '-m', 'initial commit'], { cwd: dir });

    return dir;
}

describe.skipIf(!reachable)('F6: publish CLI credential and scope derivation end-to-end', () => {
    let client: MongoClient | undefined;
    let dbName: string;
    let app: MeshApp;
    let broker: IServiceBroker;
    let bootstrapUrl: string;

    let tokenAlpha: string;
    let orgAlphaId: string;
    let tokenBeta: string;
    let orgBetaId: string;
    let tokenGamma: string;
    let orgGammaId: string;

    const fixtureDirs: string[] = [];

    beforeAll(async () => {
        dbName = `mesh-serve-pubcli-test-${String(Date.now())}`;
        client = new MongoClient(MONGO);
        await client.connect();

        const transport = new WSTransport(new JSONSerializer(), 0);
        app = new MeshApp({
            nodeID: `pub-server-${Math.random().toString(36).slice(2, 7)}`,
        });

        app.use(new RegistryModule());
        app.use(new DatabaseModule({ uri: MONGO, dbName }));
        app.use(new NetworkModule({ transports: [transport] }));
        app.use(new BrokerModule());
        await app.start();

        const wsPort = transport.getPort();
        bootstrapUrl = `ws://127.0.0.1:${String(wsPort)}`;

        await app.registerModule(new CatalogService());
        const db = app.getProvider<Database>('database');
        const store = mongoStore(db);
        await app.registerModule(createIdentityModule({ store }));

        broker = app.getProvider<IServiceBroker>('broker');

        await store.upsertRole({ key: 'owner', name: 'Owner', scope: 'organization', builtin: false });

        // Seed Org Alpha & Token Alpha
        const userAlpha = await store.createUser({ email: 'alpha@example.com', displayName: 'Alpha User', roles: [] });
        const orgAlpha = await store.createOrganization({ slug: 'org-alpha', name: 'Alpha Org', ownerId: userAlpha.id });
        await store.createMembership({ userId: userAlpha.id, organizationId: orgAlpha.id, roleKey: 'owner', joinedAt: Date.now() });
        const alphaIssued = await broker.call('identity.api_token_issue', {
            name: 'token-alpha',
            userId: userAlpha.id,
            organizationId: orgAlpha.id,
        });
        tokenAlpha = alphaIssued.token;
        orgAlphaId = orgAlpha.id;

        // Seed Org Beta & Token Beta
        const userBeta = await store.createUser({ email: 'beta@example.com', displayName: 'Beta User', roles: [] });
        const orgBeta = await store.createOrganization({ slug: 'org-beta', name: 'Beta Org', ownerId: userBeta.id });
        await store.createMembership({ userId: userBeta.id, organizationId: orgBeta.id, roleKey: 'owner', joinedAt: Date.now() });
        const betaIssued = await broker.call('identity.api_token_issue', {
            name: 'token-beta',
            userId: userBeta.id,
            organizationId: orgBeta.id,
        });
        tokenBeta = betaIssued.token;
        orgBetaId = orgBeta.id;

        // Seed User Gamma (sole membership in org-gamma, token issued without explicit organizationId)
        const userGamma = await store.createUser({ email: 'gamma@example.com', displayName: 'Gamma User', roles: [] });
        const orgGamma = await store.createOrganization({ slug: 'org-gamma', name: 'Gamma Org', ownerId: userGamma.id });
        await store.createMembership({ userId: userGamma.id, organizationId: orgGamma.id, roleKey: 'owner', joinedAt: Date.now() });
        const gammaIssued = await broker.call('identity.api_token_issue', {
            name: 'token-gamma-user',
            userId: userGamma.id,
        });
        tokenGamma = gammaIssued.token;
        orgGammaId = orgGamma.id;
    }, 60_000);

    afterAll(async () => {
        try {
            await Promise.race([
                app?.stop(),
                new Promise((resolve) => setTimeout(resolve, 2000)),
            ]);
        } catch {
            // Ignore stop errors
        }
        if (client !== undefined) {
            try {
                await client.db(dbName).dropDatabase();
            } catch {
                // Ignore cleanup errors
            }
            try {
                await client.close();
            } catch {
                // Ignore
            }
        }
        for (const dir of fixtureDirs) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('publishes end to end with a token against the running node', async () => {
        const repoBeta = await makeFixtureRepo('part-beta');
        fixtureDirs.push(repoBeta);

        const exitCode = await run_([
            '--descriptor', join(repoBeta, 'mesh.json'),
            '--token', tokenBeta,
            '--bootstrap', bootstrapUrl,
        ]);

        expect(exitCode).toBe(0);

        const part = await broker.call('part.find_one', { query: { name: 'part-beta' } });
        expect(part).toBeDefined();
        if (part === undefined) throw new Error('part-beta was not created');
        expect(part.publisher).toBe(orgBetaId);

        const version = await broker.call('partVersion.find_one', {
            query: { partName: 'part-beta', version: '1.0.0' },
        });
        expect(version).toBeDefined();
        if (version === undefined) throw new Error('part-beta version 1.0.0 was not created');
        expect(version.state).toBe('declared');
    });

    it('refuses publish with no credential, naming what is missing (MESH_TOKEN)', async () => {
        const repoNoCred = await makeFixtureRepo('part-nocred');
        fixtureDirs.push(repoNoCred);

        const origToken = process.env['MESH_TOKEN'];
        const origApiToken = process.env['MESH_API_TOKEN'];
        delete process.env['MESH_TOKEN'];
        delete process.env['MESH_API_TOKEN'];

        let stderr = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            return true;
        });

        try {
            const exitCode = await run_([
                '--descriptor', join(repoNoCred, 'mesh.json'),
                '--bootstrap', bootstrapUrl,
            ]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain('No credential. Publishing requires an API token.');
            expect(stderr).toContain('MESH_TOKEN');
        } finally {
            spy.mockRestore();
            if (origToken !== undefined) process.env['MESH_TOKEN'] = origToken;
            if (origApiToken !== undefined) process.env['MESH_API_TOKEN'] = origApiToken;
        }
    });

    it('refuses when token belonging to organization A tries to publish organization B part (404 part_not_found)', async () => {
        // part-beta is owned by org-beta. Try to publish a new version 2.0.0 using tokenAlpha
        const repoBetaV2 = await makeFixtureRepo('part-beta', '2.0.0');
        fixtureDirs.push(repoBetaV2);

        let stderr = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            return true;
        });

        try {
            const exitCode = await run_([
                '--descriptor', join(repoBetaV2, 'mesh.json'),
                '--token', tokenAlpha,
                '--bootstrap', bootstrapUrl,
            ]);

            expect(exitCode).toBe(1);
            expect(stderr).toContain('No such part.');
        } finally {
            spy.mockRestore();
        }
    });

    it('publishes end to end using MESH_TOKEN environment variable', async () => {
        const repoAlpha = await makeFixtureRepo('part-alpha');
        fixtureDirs.push(repoAlpha);

        const origToken = process.env['MESH_TOKEN'];
        process.env['MESH_TOKEN'] = tokenAlpha;

        try {
            const exitCode = await run_([
                '--descriptor', join(repoAlpha, 'mesh.json'),
                '--bootstrap', bootstrapUrl,
            ]);

            expect(exitCode).toBe(0);

            const part = await broker.call('part.find_one', { query: { name: 'part-alpha' } });
            expect(part).toBeDefined();
            if (part === undefined) throw new Error('part-alpha was not created');
            expect(part.publisher).toBe(orgAlphaId);
        } finally {
            if (origToken !== undefined) process.env['MESH_TOKEN'] = origToken;
            else delete process.env['MESH_TOKEN'];
        }
    });

    it('accepts matching --publisher assertion and rejects mismatched --publisher assertion', async () => {
        const repoAlphaAssert = await makeFixtureRepo('part-alpha-assert');
        fixtureDirs.push(repoAlphaAssert);

        let stderr = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            return true;
        });

        try {
            // Mismatched publisher assertion
            const failCode = await run_([
                '--descriptor', join(repoAlphaAssert, 'mesh.json'),
                '--token', tokenAlpha,
                '--publisher', orgBetaId,
                '--bootstrap', bootstrapUrl,
            ]);

            expect(failCode).toBe(1);
            expect(stderr).toContain(`Publisher "${orgBetaId}" does not match token organization`);

            // Matching publisher assertion
            const successCode = await run_([
                '--descriptor', join(repoAlphaAssert, 'mesh.json'),
                '--token', tokenAlpha,
                '--publisher', orgAlphaId,
                '--bootstrap', bootstrapUrl,
            ]);

            expect(successCode).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    it('resolves scope from user memberships when token has no explicit organizationId', async () => {
        const repoGamma = await makeFixtureRepo('part-gamma');
        fixtureDirs.push(repoGamma);

        const exitCode = await run_([
            '--descriptor', join(repoGamma, 'mesh.json'),
            '--token', tokenGamma,
            '--bootstrap', bootstrapUrl,
        ]);

        expect(exitCode).toBe(0);

        const part = await broker.call('part.find_one', { query: { name: 'part-gamma' } });
        expect(part).toBeDefined();
        if (part === undefined) throw new Error('part-gamma was not created');
        expect(part.publisher).toBe(orgGammaId);
    });
});
