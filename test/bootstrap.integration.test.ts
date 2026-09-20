/**
 * A real node, real MongoDB, real HTTP -- the class of bug this session kept finding by hand
 * (the `/api` routing mismatch, `identity.user.setPassword` unreachable, `serve.repo`/`serve.part`/
 * `serve.composition` completely unexposable, the bootstrap-org gap) had zero automated coverage:
 * `GenerateCommand.test.ts`/`ZodToCliMapper.test.ts` cover the contract scanner and CLI option
 * mapping, nothing exercises a booted node answering a real request. This is that coverage.
 *
 * One node, booted once (`beforeAll`), used across every test in order -- a fresh install's own
 * state (the operator's ticket, the organizations/apis created along the way) is inherently
 * sequential, and re-booting per test would mean re-running the same boot-time seeding a dozen
 * times for no real isolation gained. `beforeAll` claims the node itself, the same sequence
 * `src/bootstrap.ts` runs interactively against a real one (see `claim()` above) -- onStart no
 * longer creates an account on its own; that's the one thing this test does differently from a
 * real boot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/cdn/contracts/site.contract.js';
import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import '../src/catalog/contracts/repo.contract.js';
import '../src/catalog/contracts/part.contract.js';
import '../src/catalog/contracts/composition.contract.js';
import '../src/catalog/contracts/artifact.contract.js';
import '../src/catalog/contracts/release.contract.js';
import '../src/catalog/contracts/corePart.contract.js';
import '../src/api/contracts/api.contract.js';
import '../src/api/contracts/expose.contract.js';
import '../src/api/contracts/want.contract.js';
import '../src/api/contracts/generateClient.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const BOOTSTRAP_PASSWORD = 'a-real-operator-password-12';

/**
 * The same sequence src/bootstrap.ts runs interactively against a real node, done here directly
 * (a known password instead of a typed one) -- what this test exercises is the booted node's real
 * HTTP behavior once claimed, not bootstrap.ts's own prompt loop.
 */
async function claim(broker: IServiceBroker): Promise<{ userId: string }> {
    // Seeding the builtin roles is bootstrap's job now, not something that happens when a node
    // loads the identity part -- it writes shared cluster state, and loading is per node.
    await broker.call('identity.role.ensureBuiltins', {});

    const passwordHash = await hashPassword(BOOTSTRAP_PASSWORD);
    const user = await broker.call('identity.user.create', {
        email: 'operator@node.invalid', displayName: 'operator', passwordHash, roles: ['operator'], provisional: false,
    });
    const organization = await broker.call('identity.organization.create', {
        slug: 'platform', name: 'Platform', ownerId: user.id,
    });
    await broker.call('identity.membership.create', {
        userId: user.id, organizationId: organization.id, roleKey: 'owner', joinedAt: new Date(),
    }, { meta: { user: { id: user.id, tenant_id: '', organizationId: organization.id } } });
    await ensureBootstrapApi(broker);
    return { userId: user.id };
}

const DB_NAME = 'mesh-serve-bootstrap-integration-test';
const WS_PORT = 16554;
const API_PORT = 15554;
const CDN_PORT = 13554;
const API_ORIGIN = `http://api.localhost:${API_PORT}`;

async function json(response: Response): Promise<unknown> {
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
}

/**
 * Exposes a contract if it is not already, for tests that need one reachable as *setup* rather than
 * as the thing under test.
 *
 * "Already exposed" is a 409 from `serve.expose.add`, and it became the normal answer once
 * `BOOTSTRAP_EXPOSED_CONTRACTS` grew the management surface: the tests below were written when a
 * fresh api exposed ten contracts and everything else had to be added by hand, so their setup
 * collided with bootstrap's own rows the moment bootstrap started doing this itself. Treating
 * "it is exposed" and "I exposed it" as the same outcome is what makes these tests about the call
 * they are actually checking, rather than about which side happened to expose it first.
 */
async function ensureExposed(origin: string, token: string, apiId: string, contract: string, role?: string): Promise<void> {
    const res = await fetch(`${origin}/api/expose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ apiId, contract, ...(role !== undefined ? { role } : {}) }),
    });
    if (res.status === 200 || res.status === 409) return;
    throw new Error(`exposing ${contract}: expected 200 or 409, got ${String(res.status)} (${String(await res.text())})`);
}

describe('a fresh install, booted for real', () => {
    let app: MeshApp;
    let operatorUserId = '';
    let operatorToken = '';
    let organizationId = '';
    let apiId = '';
    let flowOrgId = '';
    let flowApiId = '';

    beforeAll(async () => {
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        await mongo.db(DB_NAME).dropDatabase();
        await mongo.close();

        process.env.API_PORT = String(API_PORT);
        process.env.SERVER_PORT = String(CDN_PORT);

        const logger = new Logger(LogLevel.INFO);

        app = new MeshApp({ nodeID: 'bootstrap-integration-test', logger });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT)] }));
        app.use(new DatabaseModule({ dbName: DB_NAME }));
        app.use(new BrokerModule());


        await app.start();

        // After start, not before: a standalone part registers against a live broker, and the
        // broker provider doesn't exist until the app has started.
        // No registration file: loadDomain reads identity's contracts from the registry (the
        // imports above are what put them there) and resolves each handler from the filePath its
        // own contract declares.
        // One call covers identity.user/.ticket/.role/... too -- loadDomain takes the domain and
        // its sub-domains, which is exactly the set one part owns.
        for (const domain of CATALOG_DOMAINS) {
            await app.getProvider<IServiceBroker>('broker').loadDomain(domain, {}, { resolve: resolveHandler });
        }
        await app.getProvider<IServiceBroker>('broker').loadDomain('identity', {}, { resolve: resolveHandler });
        await app.getProvider<IServiceBroker>('broker').loadDomain('serve.cdn', {}, { resolve: resolveHandler });
        await app.getProvider<IServiceBroker>('broker').loadDomain('serve.api', {}, { resolve: resolveHandler });
        await app.getProvider<IServiceBroker>('broker').loadDomain('serve.expose', {}, { resolve: resolveHandler });

        const broker = app.getProvider<IServiceBroker>('broker');
        await claim(broker);

        const issueRes = await fetch(`${API_ORIGIN}/api/identity/ticket`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'operator@node.invalid', password: BOOTSTRAP_PASSWORD }),
        });
        const ticket = await json(issueRes) as { token: string; userId: string };
        operatorToken = ticket.token;
        operatorUserId = ticket.userId;
    }, 30000);

    afterAll(async () => {
        await app.stop();
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        await mongo.db(DB_NAME).dropDatabase();
        await mongo.close();
    });

    it('creates a real Platform organization and owner membership, not just an operator user', async () => {
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        const db = mongo.db(DB_NAME);

        const org = await db.collection('identity.organization').findOne({ slug: 'platform' });
        expect(org).toBeDefined();
        organizationId = String(org?._id);

        const membership = await db.collection('identity.membership').findOne({ userId: operatorUserId });
        expect(membership?.roleKey).toBe('owner');

        const ownerRole = await db.collection('identity.role').findOne({ key: 'owner' });
        expect(ownerRole?.scope).toBe('organization');

        await mongo.close();
    });

    it('creates a real serve.api row for the bootstrap host, not a hostname special-cased in code', async () => {
        const mongo = new MongoClient('mongodb://127.0.0.1:27017');
        await mongo.connect();
        const api = await mongo.db(DB_NAME).collection('serve.api').findOne({ apiHost: 'api.localhost' });
        expect(api).toBeDefined();
        expect(String(api?.tenantId)).toBe(organizationId);
        apiId = String(api?._id);
        await mongo.close();
    });

    it('answers /api/_describe on the bootstrap host', async () => {
        const res = await fetch(`${API_ORIGIN}/api/_describe`);
        expect(res.status).toBe(200);
        const descriptor = await json(res) as { calls: { key: string }[] };
        const keys = descriptor.calls.map((c) => c.key);
        expect(keys).toContain('identity.whoami');
        expect(keys).toContain('identity.user.setPassword');
    });

    it('answers serve.api.describe with the same descriptor shape, real JSON Schema and destructive flags included', async () => {
        // serve.api.describe isn't auto-exposed on every api any more (no hidden magic left in
        // ApiService -- every exposure is an explicit serve.expose row an operator asked for).
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.api.describe');

        const res = await fetch(`${API_ORIGIN}/api/apis/host/api.localhost/describe`);
        expect(res.status).toBe(200);
        const descriptor = await json(res) as {
            host: string;
            calls: { key: string; destructive?: boolean; input: unknown }[];
        };
        expect(descriptor.host).toBe('api.localhost');
        const setPassword = descriptor.calls.find((c) => c.key === 'identity.user.setPassword');
        expect(setPassword).toBeDefined();
        expect(setPassword?.input).toBeTruthy();
        const exposeAdd = descriptor.calls.find((c) => c.key === 'serve.expose.add');
        expect(exposeAdd?.destructive).toBe(true);
    });

    it('404s a request missing the /api prefix -- the routing mismatch this session found and fixed', async () => {
        const res = await fetch(`${API_ORIGIN}/identity/whoami`);
        expect(res.status).toBe(404);
    });

    it('refuses an operator-gated call with no credential', async () => {
        const res = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiId, contract: 'identity.whoami' }),
        });
        expect(res.status).toBe(401);
    });

    it('refuses an operator-gated call for a signed-in caller with no operator role', async () => {
        const registerRes = await fetch(`${API_ORIGIN}/api/identity/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'nobody@example.com', password: 'not-an-operator-12', displayName: 'Nobody' }),
        });
        expect(registerRes.status).toBe(200);
        const issueRes = await fetch(`${API_ORIGIN}/api/identity/ticket`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'nobody@example.com', password: 'not-an-operator-12' }),
        });
        const { token } = await json(issueRes) as { token: string };

        const res = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ apiId, contract: 'identity.whoami' }),
        });
        expect(res.status).toBe(403);
    });

    it('whoami reports real organization membership', async () => {
        const res = await fetch(`${API_ORIGIN}/api/identity/whoami`, {
            headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.status).toBe(200);
        const who = await json(res) as { organizations: { name: string; roleKey: string }[] };
        expect(who.organizations).toEqual([{ organizationId, name: 'Platform', roleKey: 'owner' }]);
    });

    it('exposes and calls serve.repo.create, serve.part.create, serve.composition.create, and serve.expose.find -- all unreachable before this session\'s visibility fix', async () => {
        for (const contract of ['serve.repo.create', 'serve.part.create', 'serve.composition.create', 'serve.expose.find']) {
            await ensureExposed(API_ORIGIN, operatorToken, apiId, contract, 'operator');
        }

        const createRepoRes = await fetch(`${API_ORIGIN}/api/repos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ tenantId: organizationId, name: 'repo', url: 'https://example.invalid/repo.git' }),
        });
        expect(createRepoRes.status).toBe(200);

        const findExposeRes = await fetch(`${API_ORIGIN}/api/exposes`, {
            headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(findExposeRes.status).toBe(200);
        const rows = await json(findExposeRes) as { contract: string }[];
        expect(rows.map((r) => r.contract)).toContain('serve.repo.create');
    });

    it('generates a real self-contained zod client from the live exposure', async () => {
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.api.generateClient');

        // Authenticated now: the expose row above names no role, but serve.api.generateClient
        // declares permissions: ['operator'] on the contract itself, and that floor applies
        // regardless of how the row exposes it. Before the floor existed this call was anonymous --
        // a contract that hands out the api's full exposure, reachable by anyone.
        const res = await fetch(`${API_ORIGIN}/api/generate-client`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId }),
        });
        expect(res.status).toBe(200);
        const { source } = await json(res) as { source: string };

        expect(source).toContain("import { z } from 'zod'");
        expect(source).toContain("from '@flybyme/mesh-web/net'");
        // No *import* references mesh-serve -- the header comment's own prose legitimately says the
        // word ("no import of mesh-serve anywhere below"), so this checks real import statements only.
        const importLines = source.split('\n').filter((line) => line.startsWith('import '));
        expect(importLines.some((line) => line.includes('mesh-serve'))).toBe(false);
        expect(source).toContain('z.object(');
    });

    it('an operator naming an explicit tenantId creates the row in that tenant, not the api\'s own', async () => {
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.api.create', 'operator');
        // Bootstrap itself now exposes this with role: 'operator' (an operator action, not
        // self-service) -- ensureExposed leaves an already-exposed row's gate alone, so the call
        // below carries the operator's own token to match.
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'identity.organization.create', 'operator');

        const createOrgRes = await fetch(`${API_ORIGIN}/api/organizations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ name: 'Flow', slug: 'flow', ownerId: operatorUserId }),
        });
        expect(createOrgRes.status).toBe(200);
        const flowOrg = await json(createOrgRes) as { id: string };

        // Calling through Platform's own api, but naming Flow's org explicitly -- without the
        // operator override this would silently land as tenantId === organizationId (Platform's),
        // the exact bootstrap deadlock this fix closes.
        const createApiRes = await fetch(`${API_ORIGIN}/api/apis`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ tenantId: flowOrg.id, apiHost: 'flow-api.localhost' }),
        });
        expect(createApiRes.status).toBe(200);
        const flowApi = await json(createApiRes) as { tenantId: string; id: string };
        expect(flowApi.tenantId).toBe(flowOrg.id);
        flowOrgId = flowOrg.id;
        flowApiId = flowApi.id;
    });

    it('exposing a contract on another tenant\'s api lands the expose row in that tenant, not the caller\'s', async () => {
        // Calling through Platform's api as the operator, naming Flow's own api as the target --
        // serve.expose.add resolves apiId's own tenant and must scope the write to it, not to
        // whichever tenant the caller's own ambient meta carries (ServiceBroker.internalCall's
        // shallow meta merge silently defeated a flat `{ tenant_id }` override here before this fix).
        const exposeRes = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId: flowApiId, contract: 'identity.whoami' }),
        });
        expect(exposeRes.status).toBe(200);
        const row = await json(exposeRes) as { tenantId: string; apiId: string };
        expect(row.tenantId).toBe(flowOrgId);
        expect(row.tenantId).not.toBe(organizationId);
    });

    it('a site created with a real apiId links to a real serve.api, not a duplicated hostname string', async () => {
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.cdn.create');

        const createSiteRes = await fetch(`${API_ORIGIN}/api/sites`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({
                host: 'linked-site.localhost',
                apiId,
                mcpHost: 'linked-site-mcp.localhost',
                tenantId: organizationId,
                application: 'platform/linked-site',
                policy: {},
                theme: {},
                title: 'Linked Site',
                description: '',
                indexable: false,
            }),
        });
        expect(createSiteRes.status).toBe(200);
        const site = await json(createSiteRes) as { apiId: string };
        expect(site.apiId).toBe(apiId);
    });

    it('a non-operator\'s explicit tenantId is silently ignored, not honored or rejected', async () => {
        const issueRes = await fetch(`${API_ORIGIN}/api/identity/ticket`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'nobody@example.com', password: 'not-an-operator-12' }),
        });
        const { token } = await json(issueRes) as { token: string };

        // serve.cdn.create has to be reachable by a non-operator for this to test anything, and
        // bootstrap now exposes it with role 'operator' -- so drop that row and re-add it ungated.
        // Changing an api's own gating is exactly what add/remove are for, and doing it explicitly
        // here says which gate the test depends on instead of inheriting it from whichever test ran
        // before.
        await fetch(`${API_ORIGIN}/api/expose/${apiId}/${encodeURIComponent('serve.cdn.create')}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${operatorToken}` },
        });
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.cdn.create');

        // Reaches resolveEffectiveTenantId with a real, signed-in, non-operator caller.
        const createSiteRes = await fetch(`${API_ORIGIN}/api/sites`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                host: 'nobody-site.localhost',
                apiId,
                mcpHost: 'nobody-site-mcp.localhost',
                tenantId: 'not-a-real-tenant-id',
                application: 'platform/nobody-site',
                policy: {},
                theme: {},
                title: 'Nobody Site',
                description: '',
                indexable: false,
            }),
        });
        expect(createSiteRes.status).toBe(200);
        const site = await json(createSiteRes) as { tenantId: string };
        expect(site.tenantId).toBe(organizationId);
    });

    it('a scoped collection exposed with no role/permission gate is readable with no credential at all', async () => {
        // serve.repo is scopedBy tenantId and find/get/count are mesh-level public; exposing one
        // with no role means the site intends anonymous reads. Before this fix,
        // ApiService.handleRequest set meta to undefined outright for a caller-less request, so
        // DatabaseMiddleware's "requires a resolved scope" guard 401'd every gate-free scoped read
        // anyway -- found live, porting flowboard, when its board 401'd on
        // card.find/project.find/sprint.find for a signed-out visitor despite none of them being
        // role-gated.
        //
        // `count`, not `find`: bootstrap now exposes serve.repo.find with role 'operator', because
        // this api is the *management* api and its reads are an operator's business. The behaviour
        // under test is about a gate-free row, so it needs a contract no bootstrap row has already
        // gated -- which is the honest version of the original test, since a site wanting anonymous
        // reads would be a different api entirely.
        await ensureExposed(API_ORIGIN, operatorToken, apiId, 'serve.repo.count');

        const anonRes = await fetch(`${API_ORIGIN}/api/repos/count`);
        expect(anonRes.status).toBe(200);
        // Reached the database and resolved a scope rather than 401ing for having no caller. The
        // count itself is whatever earlier tests left behind; that it answered at all is the point.
        expect(typeof await json(anonRes)).not.toBe('undefined');
    });
});
