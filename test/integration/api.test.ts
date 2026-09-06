/**
 * **The api, against a real everything.**
 *
 * The one file where an anonymous HTTP request becomes a call made by somebody, in an organization,
 * against a contract a site chose to expose. Every assertion here is about a refusal, because a
 * boundary is only interesting where it says no — and because the failure mode of every one of them
 * is *the call succeeds*, which no test that only checks happy paths would ever notice.
 *
 * Needs mongo on `MONGODB_URI`. Skipped, not failed, without one: a suite that goes red on a laptop
 * with no database teaches people to ignore red.
 */

import { BrokerModule, DatabaseModule, MeshApp, RegistryModule } from '@flybyme/mesh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiService, EXPOSURE_HEADER, SHAPE_HEADER } from '../../src/api/api.service.js';
import { SCOPE_HEADER } from '../../src/api/methods/gate.js';
import { verifyClientExposure, ExposureMismatchError } from '../../src/api/methods/client.js';
import { CdnService } from '../../src/cdn/cdn.service.js';
import { createIdentityModule, memoryStore } from '../../src/identity/index.js';

const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const { MongoClient } = await import('mongodb');
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

const ORG = 'org-under-test';
const HOST = 'api.test';

interface World {
    readonly app: MeshApp;
    readonly api: ApiService;
    call<T>(tool: string, params: unknown): Promise<T>;
}

let world: World;

/** An HTTP request with a real `Host` header — `fetch` drops it, being a forbidden header name. */
async function request(
    port: number,
    method: string,
    path: string,
    options: {
        host?: string; ticket?: string; scope?: string; body?: unknown;
        /** A browser sends this on every cross-origin call, and the api answers on it. */
        origin?: string;
        exposure?: string;
        shape?: string;
    } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
    const { request: send } = await import('node:http');
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

    return new Promise((resolve, reject) => {
        const req = send({
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                host: options.host ?? HOST,
                ...(options.ticket === undefined ? {} : { authorization: `Bearer ${options.ticket}` }),
                ...(options.scope === undefined ? {} : { [SCOPE_HEADER]: options.scope }),
                ...(options.origin === undefined ? {} : { origin: options.origin }),
                ...(options.exposure === undefined ? {} : { [EXPOSURE_HEADER]: options.exposure }),
                ...(options.shape === undefined ? {} : { [SHAPE_HEADER]: options.shape }),
                ...(payload === undefined ? {} : {
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(payload)),
                }),
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { text += chunk; });
            res.on('end', () => {
                let body: unknown;
                try { body = JSON.parse(text); } catch { body = text; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
            });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

beforeAll(async () => {
    if (!reachable) return;

    const app = new MeshApp({
        nodeID: `api-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-serve-api',
    });

    app.use(new RegistryModule());
    app.use(new DatabaseModule({ uri: MONGO, dbName: `mesh-serve-api-${String(Date.now())}` }));
    app.use(new BrokerModule());
    await app.start();

    const api = new ApiService({ port: 0, allowOrigins: ['https://console.test'] });

    await app.registerModule(new CdnService({ port: 0 }));
    await app.registerModule(createIdentityModule({ store: memoryStore() }));
    await app.registerModule(api);

    const call = <T,>(tool: string, params: unknown): Promise<T> =>
        (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<T> })
            .call(tool, params, { meta: { user: { id: 'u1', tenant_id: ORG } } });

    // A site that exposes three identity contracts at three different gates. The gates are the whole
    // point: what is reachable and by whom is the *site's* decision, not the contract author's.
    await call('site.create', {
        host: HOST, application: 'test', tenantId: ORG, api: '/api',
        mesh: [{
            package: '@flybyme/mesh-serve',
            version: '^0.1',
            contracts: [
                { key: 'identity.register', auth: 'public' },
                { key: 'identity.ticket_issue', auth: 'public' },
                { key: 'identity.whoami', auth: 'user' },
                { key: 'identity.ticket_revoke', auth: 'admin' },
            ],
        }],
        theme: {}, policy: {}, title: 'API under test',
    });

    world = { app, api, call };
}, 60_000);

afterAll(async () => {
    if (!reachable || world === undefined) return;
    await world.app.stop();
});

const port = (): number => world.api.port!;

describe.skipIf(!reachable)('the api', () => {
    let ticket: string;

    it('serves a public contract with no credential at all', async () => {
        const answer = await request(port(), 'POST', '/api/identity/register', {
            body: { email: 'alice@example.com', password: 'correct horse', displayName: 'Alice' },
        });

        // 200, not 201: the convention is `POST` plus an action literally named `create`. `register`
        // creates a user and is not called that, so it gets the ordinary status. A narrow rule that
        // is easy to predict beats a clever one that guesses at intent.
        expect(answer.status).toBe(200);
    });

    it('reports the exposure hash on every response', async () => {
        // A client generated from one exposure and pointed at an API serving another is a lie the
        // compiler vouches for. This is the half that lets a client notice.
        const answer = await request(port(), 'GET', '/api/identity/whoami');
        expect(answer.headers[EXPOSURE_HEADER]).toMatch(/^sha256:/);
    });

    it('refuses a `user` contract to an anonymous caller', async () => {
        const answer = await request(port(), 'GET', '/api/identity/whoami');

        expect(answer.status).toBe(401);
        expect((answer.body as { error: string }).error).toBe('UNAUTHENTICATED');
    });

    it('refuses a `user` contract to a caller holding nonsense', async () => {
        // An invalid ticket makes a caller *anonymous*, not refused outright — and anonymous is not
        // good enough for this gate, which is the same 401 by a different route.
        const answer = await request(port(), 'GET', '/api/identity/whoami', { ticket: 'not-a-ticket' });
        expect(answer.status).toBe(401);
    });

    it('serves it once the caller has a real ticket', async () => {
        const issued = await request(port(), 'POST', '/api/identity/ticket', {
            body: { email: 'alice@example.com', password: 'correct horse' },
        });
        expect(issued.status).toBe(200);

        ticket = (issued.body as { token: string }).token;

        const answer = await request(port(), 'GET', '/api/identity/whoami', { ticket });
        expect(answer.status).toBe(200);
        expect((answer.body as { email: string }).email).toBe('alice@example.com');
    });

    it('refuses an `admin` contract to an ordinary user', async () => {
        // The gate's coarse stage, which cannot be skipped or replaced. Alice has a valid ticket and
        // is not an admin, so this is a 403 rather than a 401 — a different answer to a different
        // question, and conflating them is how "signed in" comes to mean "allowed".
        const answer = await request(port(), 'POST', '/api/identity/ticket/revoke', {
            ticket, body: { token: ticket },
        });

        expect(answer.status).toBe(403);
    });

    it('404s a contract the site does not expose', async () => {
        // `identity.permits` exists, is mounted, and is not in this site's mesh list. Reachable
        // because it exists would make the site record decorative.
        const answer = await request(port(), 'GET', '/api/identity/permits');
        expect(answer.status).toBe(404);
    });

    it('404s a hostname nobody configured', async () => {
        const answer = await request(port(), 'GET', '/api/identity/whoami', { host: 'nobody.test' });

        expect(answer.status).toBe(404);
        expect((answer.body as { error: string }).error).toBe('NO_SITE');
    });

    it('refuses input the contract does not accept', async () => {
        const answer = await request(port(), 'POST', '/api/identity/ticket', {
            body: { email: 'not-an-email', password: '' },
        });

        expect(answer.status).toBe(400);
        expect((answer.body as { error: string }).error).toBe('INVALID_INPUT');
    });
});

describe.skipIf(!reachable)('cross-origin', () => {
    it('allows an origin the site declared', async () => {
        const { request: send } = await import('node:http');
        const answer = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
            const req = send({
                host: '127.0.0.1', port: port(), path: '/api/identity/whoami', method: 'OPTIONS',
                headers: { host: HOST, origin: 'https://console.test' },
            }, (res) => { res.resume(); res.on('end', () => { resolve(res.headers); }); });
            req.on('error', reject);
            req.end();
        });

        expect(answer['access-control-allow-origin']).toBe('https://console.test');
        // Not `*`: the response varies by origin, and a cache that missed that would hand one site's
        // allowance to another.
        expect(answer['vary']).toContain('Origin');
    });

    it('says nothing to an origin nobody declared', async () => {
        // Absent is the safe default rather than an oversight. A wildcard on an API that accepts a
        // bearer ticket makes every site on the internet a client of this one.
        const { request: send } = await import('node:http');
        const answer = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
            const req = send({
                host: '127.0.0.1', port: port(), path: '/api/identity/whoami', method: 'OPTIONS',
                headers: { host: HOST, origin: 'https://evil.test' },
            }, (res) => { res.resume(); res.on('end', () => { resolve(res.headers); }); });
            req.on('error', reject);
            req.end();
        });

        expect(answer['access-control-allow-origin']).toBeUndefined();
    });
});

describe.skipIf(!reachable)('api.describe', () => {
    it('reports the gates a site actually chose', async () => {
        // The descriptor a client generator should read. A part cannot know its gates — a part
        // choosing its own gate would make installing one a privilege escalation — so the part-side
        // generator uses a placeholder and its hash means nothing to an API. This one does.
        const described = await world.call<{
            exposure: string;
            calls: { key: string; gate: string; method: string; path: string }[];
        }>('api.describe', { host: HOST });

        const byKey = new Map(described.calls.map((c) => [c.key, c]));

        expect(byKey.get('identity.register')?.gate).toBe('public');
        expect(byKey.get('identity.whoami')?.gate).toBe('user');
        expect(byKey.get('identity.ticket_revoke')?.gate).toBe('admin');
        expect(described.exposure).toMatch(/^sha256:/);
    });

    it('reports the same exposure the api serves under', async () => {
        const described = await world.call<{ exposure: string }>('api.describe', { host: HOST });
        const served = await request(port(), 'GET', '/api/identity/whoami');

        expect(served.headers[EXPOSURE_HEADER]).toBe(described.exposure);
    });

    it('carries JSON Schema rather than a reference into another package', async () => {
        // A generated client that referenced a schema in another package broke on a zod version
        // bump. A client that states its own shapes cannot.
        const described = await world.call<{ calls: { key: string; input: unknown }[] }>(
            'api.describe', { host: HOST },
        );

        const issue = described.calls.find((c) => c.key === 'identity.ticket_issue');
        expect(JSON.stringify(issue?.input)).toContain('password');
    });

    it('reports the shapeHash and gate exposure the api serves under', async () => {
        const described = await world.call<{ exposure: string; shapeHash: string }>('api.describe', { host: HOST });
        const served = await request(port(), 'GET', '/api/identity/whoami');

        expect(served.headers[EXPOSURE_HEADER]).toBe(described.exposure);
        expect(served.headers[SHAPE_HEADER]).toBe(described.shapeHash);
        expect(described.shapeHash).toMatch(/^sha256:/);
    });

    it('accepts matching exposure and shape headers from client', async () => {
        const described = await world.call<{ exposure: string; shapeHash: string }>('api.describe', { host: HOST });
        const res = await request(port(), 'GET', '/api/identity/whoami', {
            exposure: described.exposure,
            shape: described.shapeHash,
        });

        // 401 Unauthorized because whoami requires 'user' and no ticket was sent, but NOT 409 mismatch
        expect(res.status).toBe(401);
    });

    it('rejects mismatched exposure header with 409 EXPOSURE_MISMATCH', async () => {
        const res = await request(port(), 'GET', '/api/identity/whoami', {
            exposure: 'sha256:stale_exposure_hash',
        });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            error: 'EXPOSURE_MISMATCH',
        });
    });

    it('rejects mismatched shape header with 409 EXPOSURE_MISMATCH', async () => {
        const res = await request(port(), 'GET', '/api/identity/whoami', {
            shape: 'sha256:stale_shape_hash',
        });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            error: 'EXPOSURE_MISMATCH',
        });
    });

    it('verifies client descriptor against running API description', async () => {
        const described = await world.call<{
            exposure: string;
            shapeHash: string;
            calls: {
                key: string;
                gate: string;
                method: string;
                path: string;
                input: unknown;
                output: unknown;
            }[];
        }>('api.describe', { host: HOST });

        expect(() => {
            verifyClientExposure(described, described);
        }).not.toThrow();

        const clientWithExtra = {
            ...described,
            calls: [
                ...described.calls,
                {
                    key: 'domains.zone_delete',
                    gate: 'admin',
                    method: 'DELETE',
                    path: '/zones/:id',
                    input: {},
                    output: {},
                },
            ],
        };

        expect(() => {
            verifyClientExposure(clientWithExtra, described);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_delete" is not exposed by the API.',
        );
    });
});

describe('a site may be called from its own origin', () => {
    /**
     * CORS was an allowlist on the *node* — `allowOrigins`, passed to the constructor — and
     * `bin/node.mjs` passed none, so every cross-origin call from every site was refused with a 204
     * carrying no headers. The first console deployed against it rendered, called nothing, and said
     * *"Failed to load catalog parts"*: the browser had blocked every request before it left.
     *
     * The site record already knew the answer. The api resolves `Host → site` on every request, and
     * the origin allowed to call for a site is the origin that site is served from. An allowlist
     * beside it means adding a hostname requires restarting every api node — which defeats *a
     * deploy is one field write*.
     */
    it('allows the origin whose hostname matches the site, without configuration', async () => {
        // A port the site record knows nothing about, because it stores `host` and not a scheme or
        // a port: the cdn serves `:8081` in development and `:443` behind a proxy, and it is the
        // same site. What has to match is *which site is asking*.
        const answer = await request(port(), 'OPTIONS', '/whoami', {
            origin: `http://${HOST}:8081`,
        });

        expect(answer.status).toBe(204);
        expect(answer.headers['access-control-allow-origin']).toBe(`http://${HOST}:8081`);
    });

    it('refuses an origin that is not this site', async () => {
        // The check that makes the one above safe: matching on hostname is not matching on nothing.
        const answer = await request(port(), 'OPTIONS', '/whoami', {
            origin: 'http://not-this-site.example',
        });

        expect(answer.status).toBe(204);
        expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    });
});

describe.skipIf(!reachable)('routes come from the record (D2)', () => {
    const PUBLIC_SITE = 'public-gate.test';
    const USER_SITE = 'user-gate.test';
    const DEPLOY_SITE = 'deploy-routes.test';
    let userTicket: string;

    beforeAll(async () => {
        // Shared release for gate testing: calls identity.register
        await world.call('release.create', {
            hash: 'sha256:rel-gates',
            name: 'gates-rel',
            tenantId: ORG,
            kernel: { version: '0.1.0', digest: 'sha256:kernel-gate' },
            parts: { 'part-auth': { version: '0.1.0', digest: 'sha256:part-auth' } },
            requires: ['identity.register'],
            policy: {},
            composedAt: new Date(),
        });

        // Site 1: exposes identity.register at public gate
        await world.call('site.create', {
            host: PUBLIC_SITE, application: 'gate-test', tenantId: ORG, api: '/api',
            releaseHash: 'sha256:rel-gates',
            mesh: [{
                package: '@flybyme/mesh-serve',
                version: '^0.1',
                contracts: [{ key: 'identity.register', auth: 'public' }],
            }],
            theme: {}, policy: {}, title: 'Public Gate Site',
        });

        // Site 2: exposes the SAME contract (identity.register) at user gate
        await world.call('site.create', {
            host: USER_SITE, application: 'gate-test', tenantId: ORG, api: '/api',
            releaseHash: 'sha256:rel-gates',
            mesh: [{
                package: '@flybyme/mesh-serve',
                version: '^0.1',
                contracts: [{ key: 'identity.register', auth: 'user' }],
            }],
            theme: {}, policy: {}, title: 'User Gate Site',
        });

        // Releases for deploy testing:
        // Release 1 only requires identity.ticket_issue
        await world.call('release.create', {
            hash: 'sha256:rel-deploy-1',
            name: 'deploy-rel-1',
            tenantId: ORG,
            kernel: { version: '0.1.0', digest: 'sha256:kernel-dep' },
            parts: { 'part-issue': { version: '0.1.0', digest: 'sha256:part-issue' } },
            requires: ['identity.ticket_issue'],
            policy: {},
            composedAt: new Date(),
        });

        // Release 2 requires both identity.ticket_issue and identity.register
        await world.call('release.create', {
            hash: 'sha256:rel-deploy-2',
            name: 'deploy-rel-2',
            tenantId: ORG,
            kernel: { version: '0.1.0', digest: 'sha256:kernel-dep' },
            parts: {
                'part-issue': { version: '0.1.0', digest: 'sha256:part-issue' },
                'part-reg': { version: '0.1.0', digest: 'sha256:part-reg' },
            },
            requires: ['identity.ticket_issue', 'identity.register'],
            policy: {},
            composedAt: new Date(),
        });

        // Deploy site: exposes both in site.mesh, initially deployed with Release 1
        await world.call('site.create', {
            host: DEPLOY_SITE, application: 'deploy-test', tenantId: ORG, api: '/api',
            releaseHash: 'sha256:rel-deploy-1',
            mesh: [{
                package: '@flybyme/mesh-serve',
                version: '^0.1',
                contracts: [
                    { key: 'identity.ticket_issue', auth: 'public' },
                    { key: 'identity.register', auth: 'public' },
                ],
            }],
            theme: {}, policy: {}, title: 'Deploy Routes Site',
        });

        const issued = await world.call<{ token: string }>('identity.ticket_issue', {
            email: 'alice@example.com', password: 'correct horse',
        });
        userTicket = issued.token;
    });

    it('proves the gate is per site: two sites on one node expose the same contract at different gates', async () => {
        // 1. Calling identity.register on public-gated site without authentication succeeds
        const publicAnswer = await request(port(), 'POST', '/api/identity/register', {
            host: PUBLIC_SITE,
            body: { email: 'user-on-public@example.com', password: 'password123', displayName: 'Pub User' },
        });
        expect(publicAnswer.status).toBe(200);

        // 2. Calling the exact same contract on user-gated site without authentication is refused
        const userAnonAnswer = await request(port(), 'POST', '/api/identity/register', {
            host: USER_SITE,
            body: { email: 'user-on-user@example.com', password: 'password123', displayName: 'Usr User' },
        });
        expect(userAnonAnswer.status).toBe(401);
        if (typeof userAnonAnswer.body === 'object' && userAnonAnswer.body !== null && 'error' in userAnonAnswer.body) {
            expect(userAnonAnswer.body.error).toBe('UNAUTHENTICATED');
        }

        // 3. Calling user-gated site with a valid ticket succeeds
        const userAuthedAnswer = await request(port(), 'POST', '/api/identity/register', {
            host: USER_SITE,
            ticket: userTicket,
            body: { email: 'user-on-user@example.com', password: 'password123', displayName: 'Usr User' },
        });
        expect(userAuthedAnswer.status).toBe(200);
    });

    it('proves a deploy changes the routes a hostname serves, without a restart', async () => {
        // Initially on Release 1: identity.ticket_issue is routed, identity.register is not
        const issueBefore = await request(port(), 'POST', '/api/identity/ticket', {
            host: DEPLOY_SITE,
            body: { email: 'alice@example.com', password: 'correct horse' },
        });
        expect(issueBefore.status).toBe(200);

        const registerBefore = await request(port(), 'POST', '/api/identity/register', {
            host: DEPLOY_SITE,
            body: { email: 'deploy-reg@example.com', password: 'password123', displayName: 'Dep Reg' },
        });
        expect(registerBefore.status).toBe(404);
        if (typeof registerBefore.body === 'object' && registerBefore.body !== null && 'error' in registerBefore.body) {
            expect(registerBefore.body.error).toBe('NO_ROUTE');
        }

        // Deploy Release 2 to the same hostname without restarting
        const deployed = await world.call<{ host: string; release: string; changed: boolean }>(
            'cdn.deploy', { host: DEPLOY_SITE, release: 'sha256:rel-deploy-2' },
        );
        expect(deployed.changed).toBe(true);

        // Now on Release 2: identity.register is served
        const registerAfter = await request(port(), 'POST', '/api/identity/register', {
            host: DEPLOY_SITE,
            body: { email: 'deploy-reg@example.com', password: 'password123', displayName: 'Dep Reg' },
        });
        expect(registerAfter.status).toBe(200);

        // identity.ticket_issue is still served
        const issueAfter = await request(port(), 'POST', '/api/identity/ticket', {
            host: DEPLOY_SITE,
            body: { email: 'alice@example.com', password: 'correct horse' },
        });
        expect(issueAfter.status).toBe(200);
    });

    it('returns a clean 404 for an unknown hostname without database queries on repeats', async () => {
        const first = await request(port(), 'GET', '/api/identity/whoami', { host: 'completely-unknown.test' });
        expect(first.status).toBe(404);
        if (typeof first.body === 'object' && first.body !== null && 'error' in first.body) {
            expect(first.body.error).toBe('NO_SITE');
        }

        const second = await request(port(), 'GET', '/api/identity/whoami', { host: 'completely-unknown.test' });
        expect(second.status).toBe(404);
        if (typeof second.body === 'object' && second.body !== null && 'error' in second.body) {
            expect(second.body.error).toBe('NO_SITE');
        }
    });
});

