/**
 * A real node, real MongoDB, real HTTP -- the class of bug this session kept finding by hand
 * (the `/api` routing mismatch, `identity.user.setPassword` unreachable, `serve.repo`/`serve.part`/
 * `serve.composition` completely unexposable, the bootstrap-org gap) had zero automated coverage:
 * `GenerateCommand.test.ts`/`ZodToCliMapper.test.ts` cover the contract scanner and CLI option
 * mapping, nothing exercises a booted node answering a real request. This is that coverage.
 *
 * One node, booted once (`beforeAll`), used across every test in order -- a fresh install's own
 * state (the provisional operator's password, its ticket once claimed) is inherently sequential, and
 * re-booting per test would mean re-running the same boot-time seeding a dozen times for no real
 * isolation gained.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { IdentityService } from '../src/identity/identity.service.js';
import { CdnService } from '../src/cdn/cdn.service.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { ApiService } from '../src/api/api.service.js';

const DB_NAME = 'mesh-serve-bootstrap-integration-test';
const WS_PORT = 16554;
const API_PORT = 15554;
const CDN_PORT = 13554;
const API_ORIGIN = `http://api.localhost:${API_PORT}`;

async function json(response: Response): Promise<unknown> {
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
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

        // Same INFO-level, real Logger the CLI already builds one of (BaseCommand.ts) -- just with a
        // callback that also captures the one-time first-boot message, since that's the only channel
        // the printed password ever goes out on and this test has to authenticate as that real
        // account, not a stand-in for it.
        let bootMessage = '';
        const logger = new Logger(LogLevel.INFO, {}, (_level, _formatted, originalMsg) => {
            if (typeof originalMsg === 'string' && originalMsg.includes('FIRST BOOT')) bootMessage = originalMsg;
        });

        app = new MeshApp({ nodeID: 'bootstrap-integration-test', logger });
        app.use(new RegistryModule({ ttl: 5000 }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT)] }));
        app.use(new DatabaseModule({ dbName: DB_NAME }));
        app.use(new BrokerModule());

        await app.registerModule(new IdentityService());
        await app.registerModule(new CdnService());
        await app.registerModule(new CatalogService());
        await app.registerModule(new ApiService());

        await app.start();

        const passwordMatch = /password\s+(\S+)/.exec(bootMessage);
        if (passwordMatch?.[1] === undefined) {
            throw new Error(`Boot did not print the expected first-boot message: ${bootMessage}`);
        }
        const bootstrapPassword = passwordMatch[1];

        const issueRes = await fetch(`${API_ORIGIN}/api/identity/ticket`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'operator@node.invalid', password: bootstrapPassword }),
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

    it('lets the real first-boot operator claim their provisional account', async () => {
        const res = await fetch(`${API_ORIGIN}/api/identity/password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ password: 'a-real-operator-password-12' }),
        });
        expect(res.status).toBe(200);
        const body = await json(res) as { ok: boolean; claimed: boolean };
        expect(body).toEqual({ ok: true, claimed: true });
    });

    it('whoami reports real organization membership once claimed', async () => {
        const res = await fetch(`${API_ORIGIN}/api/identity/whoami`, {
            headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.status).toBe(200);
        const who = await json(res) as { organizations: { name: string; roleKey: string }[] };
        expect(who.organizations).toEqual([{ organizationId, name: 'Platform', roleKey: 'owner' }]);
    });

    it('exposes and calls serve.repo.create, serve.part.create, serve.composition.create, and serve.expose.find -- all unreachable before this session\'s visibility fix', async () => {
        for (const contract of ['serve.repo.create', 'serve.part.create', 'serve.composition.create', 'serve.expose.find']) {
            const res = await fetch(`${API_ORIGIN}/api/expose`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
                body: JSON.stringify({ apiId, contract, role: 'operator' }),
            });
            expect(res.status, `exposing ${contract}`).toBe(200);
        }

        const createRepoRes = await fetch(`${API_ORIGIN}/api/repos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ tenantId: organizationId, url: 'https://example.invalid/repo.git' }),
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
        const exposeRes = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId, contract: 'serve.api.generateClient' }),
        });
        expect(exposeRes.status).toBe(200);

        const res = await fetch(`${API_ORIGIN}/api/generate-client`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
        const exposeApiCreateRes = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId, contract: 'serve.api.create', role: 'operator' }),
        });
        expect(exposeApiCreateRes.status).toBe(200);

        const exposeOrgCreateRes = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId, contract: 'identity.organization.create' }),
        });
        expect(exposeOrgCreateRes.status).toBe(200);

        const createOrgRes = await fetch(`${API_ORIGIN}/api/organizations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
        const exposeRes = await fetch(`${API_ORIGIN}/api/expose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
            body: JSON.stringify({ apiId, contract: 'serve.cdn.create' }),
        });
        expect(exposeRes.status).toBe(200);

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

        // serve.cdn.create is exposed with no role gate (previous test) -- reaches
        // resolveEffectiveTenantId with a real, signed-in, non-operator caller.
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
});
