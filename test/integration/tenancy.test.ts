/**
 * **Two organizations, three accounts, and every answer the gate gives.**
 *
 * This is the fixture `spec/v9-sweep.md` says is missing. That sweep read the exposed surface and
 * said so in its header — *"Read-only. Nothing was run"* — and closed on the number that mattered:
 * **exercised through the real HTTP gate by any test, anywhere: three.** Running the rest by hand,
 * on a live two-tenant cluster, found F23, F25, F26, F27 and F28 in an afternoon. A sweep that
 * cannot be re-run is a list of intentions again the day after, so it is here.
 *
 * **Nothing below can be established on a cluster with one organization**, which is why none of it
 * was. A scoped read and an unscoped one return the same rows to the only member there is; a
 * hostname cannot disambiguate a scope for somebody who has only one. The isolation the whole
 * platform rests on is unobservable until a second tenant exists — surfdns freeze gate V15.
 *
 * The three accounts are the three kinds of caller there are:
 *
 * | | roles | organizations |
 * | --- | --- | --- |
 * | operator | `operator` | **both** — the case F22 was found in |
 * | tenant owner | none | one |
 * | stranger | none | **none** |
 *
 * Needs mongo on `MONGODB_URI`. Skipped, not failed, without one.
 */

import { BrokerModule, DatabaseModule, MeshApp, RegistryModule } from '@flybyme/mesh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiService } from '../../src/api/api.service.js';
import { membershipAuthorize } from '../../src/api/methods/authorize.js';
import { SCOPE_HEADER } from '../../src/api/methods/gate.js';
import { CdnService } from '../../src/cdn/cdn.service.js';
import { createIdentityModule, mongoStore } from '../../src/identity/index.js';

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

const PLATFORM_HOST = 'platform.tenancy.test';
const TENANT_HOST = 'tenant.tenancy.test';

/** What both sites expose, and the gates are the point: one of each kind the coarse gate knows. */
const EXPOSED = [
    { key: 'identity.register', auth: 'public' as const },
    { key: 'identity.ticket_issue', auth: 'public' as const },
    { key: 'identity.whoami', auth: 'user' as const },
    // `user`, and roadmap F28 is that it was `operator` on every seeded site until 2026-09-10.
    { key: 'identity.set_password', auth: 'user' as const },
    // The scoped read. `site` is `scopedBy: 'tenantId'`, so what comes back *is* the isolation.
    { key: 'site.find', auth: 'user' as const },
    { key: 'cdn.deploy', auth: 'operator' as const },
];

interface Person { readonly userId: string; readonly email: string; ticket: string }

interface World {
    readonly app: MeshApp;
    readonly api: ApiService;
    call<T>(tool: string, params: unknown, meta?: unknown): Promise<T>;
    platformOrg: string;
    tenantOrg: string;
    operator: Person;
    owner: Person;
    stranger: Person;
}

let world: World;

async function request(
    port: number,
    method: string,
    path: string,
    options: { host: string; ticket?: string; scope?: string; body?: unknown } ,
): Promise<{ status: number; body: unknown }> {
    const { request: send } = await import('node:http');
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

    return new Promise((resolve, reject) => {
        const req = send({
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                host: options.host,
                ...(options.ticket === undefined ? {} : { authorization: `Bearer ${options.ticket}` }),
                ...(options.scope === undefined ? {} : { [SCOPE_HEADER]: options.scope }),
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
                resolve({ status: res.statusCode ?? 0, body });
            });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

const port = (): number => world.api.port!;

/** Sign in over HTTP, the way anything else would. */
async function signIn(email: string, password: string, host = PLATFORM_HOST): Promise<string> {
    const issued = await request(port(), 'POST', '/api/identity/ticket', { host, body: { email, password } });
    if (issued.status !== 200) throw new Error(`sign-in for ${email}: ${JSON.stringify(issued.body)}`);
    return (issued.body as { token: string }).token;
}

beforeAll(async () => {
    if (!reachable) return;

    const app = new MeshApp({
        nodeID: `tenancy-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-serve-tenancy',
    });
    app.use(new RegistryModule());
    app.use(new DatabaseModule({ uri: MONGO, dbName: `mesh-serve-tenancy-${String(Date.now())}` }));
    app.use(new BrokerModule());
    await app.start();

    /**
     * **The same hook `bin/node.mjs` installs**, imported rather than re-written. A test that
     * asserts against its own copy of the thing under test asserts nothing — which is exactly how
     * F25 survived, with a test in this repository stating the broken value.
     */
    const api = new ApiService({
        port: 0,
        authorize: membershipAuthorize((tool, params, options) =>
            (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<unknown> })
                .call(tool, params, options)),
    });
    await app.registerModule(new CdnService({ port: 0 }));
    /**
     * `mongoStore`, not `memoryStore`, and it is not a detail. `identity.whoami` answers a caller's
     * organizations from the **store**, while `organization.create` and `membership.create` write
     * through the CRUD collections — so an in-memory store and a mongo-backed collection are two
     * different sets of memberships, and every scope resolves to nothing. It is what the real node
     * installs (`bin/node.mjs`), which is the argument for it either way.
     */
    await app.registerModule(createIdentityModule({
        store: mongoStore(app.getProvider('database')),
    }));
    await app.registerModule(api);

    const call = <T,>(tool: string, params: unknown, meta?: unknown): Promise<T> =>
        (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<T> })
            .call(tool, params, meta === undefined ? undefined : { meta });

    world = {
        app, api, call,
        platformOrg: '', tenantOrg: '',
        operator: { userId: '', email: '', ticket: '' },
        owner: { userId: '', email: '', ticket: '' },
        stranger: { userId: '', email: '', ticket: '' },
    };

    /**
     * The bootstrap site exists so `identity.register` and `identity.ticket_issue` are reachable
     * over HTTP before there is anything else — which is the ordinary shape of a cluster, and the
     * reason `ALWAYS_GRANTED` exists.
     */
    const siteRecord = (host: string, tenantId: string) => ({
        host, application: 'tenancy', tenantId, api: '/api',
        mesh: [{ package: '@flybyme/mesh-serve', version: '^0.1', contracts: EXPOSED }],
        theme: {}, policy: {}, title: host,
    });

    const asService = { user: { id: 'bootstrap', roles: ['operator'] } };

    // Three accounts, registered the way a person would.
    const register = async (email: string, password: string): Promise<Person> => {
        const created = await call<{ userId?: string; id?: string }>('identity.register',
            { email, password, displayName: email }, asService);
        return { userId: created.userId ?? created.id ?? '', email, ticket: '' };
    };

    world.operator = await register('operator@tenancy.test', 'operator-password-1');
    world.owner = await register('owner@tenancy.test', 'owner-password-1');
    world.stranger = await register('stranger@tenancy.test', 'stranger-password-1');

    // Platform standing, checked by the handler itself rather than by a gate.
    await call('identity.grant_role', { userId: world.operator.userId, role: 'operator' }, asService);

    /**
     * **The platform's own organization already exists.** `CdnService` creates it on start, along
     * with the control site it owns — `PLATFORM_SLUG`, *"not a tenant, the platform's own row"* —
     * so this reads it rather than making a second one, which the unique slug would refuse anyway.
     * That is the arrangement on a real cluster and the reason to reproduce it here.
     */
    const platform = await call<{ id: string } | null>('organization.find_one',
        { query: { slug: 'platform' } }, asService);
    if (platform === null) throw new Error('the control site did not create the platform organization');
    world.platformOrg = platform.id;

    // The tenant, created by the person who will own it: `organization.create` stamps the caller as
    // owner and writes the owner membership itself, so who calls is what makes it somebody's.
    const tenant = await call<{ id: string }>('organization.create',
        { slug: 'tenant-inc', name: 'Tenant Inc', ownerId: world.owner.userId },
        { user: { id: world.owner.userId } });
    world.tenantOrg = tenant.id;

    /**
     * **The operator belongs to both**, which is the condition F22 was found in and is not a
     * contrivance: the caller who seeds a tenant becomes its owner (freeze gate V8b), so on a real
     * cluster the operator owns every tenant it ever seeded.
     */
    for (const organizationId of [world.platformOrg, world.tenantOrg]) {
        await call('membership.create', {
            userId: world.operator.userId, organizationId, roleKey: 'owner', joinedAt: Date.now(),
        }, { user: { id: world.operator.userId, roles: ['operator'] }, organizationId });
    }

    /**
     * `site` is `scopedBy: 'tenantId'`, so a write needs a caller acting *in* an organization —
     * there is no way to create a site belonging to nobody, which is the point of the scope.
     */
    const inOrg = (organizationId: string) => ({
        user: { id: world.operator.userId, roles: ['operator'], tenant_id: organizationId },
        tenant_id: organizationId,
    });

    await call('site.create', siteRecord(PLATFORM_HOST, world.platformOrg), inOrg(world.platformOrg));
    await call('site.create', siteRecord(TENANT_HOST, world.tenantOrg), inOrg(world.tenantOrg));

    // A second site for the platform, so a count can tell the two apart from the one each has.
    await call('site.create', siteRecord('extra-platform.tenancy.test', world.platformOrg), inOrg(world.platformOrg));

    world.operator.ticket = await signIn(world.operator.email, 'operator-password-1');
    world.owner.ticket = await signIn(world.owner.email, 'owner-password-1');
    world.stranger.ticket = await signIn(world.stranger.email, 'stranger-password-1');
}, 60_000);

afterAll(async () => {
    if (!reachable || world === undefined) return;
    await world.app.stop();
});

const sitesOn = (host: string, person: () => Person, scope?: string) =>
    request(port(), 'GET', '/api/sites', {
        host, ticket: person().ticket, ...(scope === undefined ? {} : { scope }),
    });

const tenantsIn = (body: unknown): string[] =>
    [...new Set((body as { tenantId: string }[]).map((s) => s.tenantId))];

describe.skipIf(!reachable)('a stranger', () => {
    /**
     * **The finding this whole gate exists for**, in flowboard's half: before its collections were
     * scoped, an account belonging to no organization read a card titled *PRIVATE: Flowboard Inc
     * roadmap*. The platform's own collections were already scoped, and this is the assertion that
     * says so and keeps saying so.
     */
    it('reads nothing on a tenant\'s hostname, and is told what is missing', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.stranger);

        expect(answer.status).toBe(400);
        expect((answer.body as { error: string }).error).toBe('ORGANIZATION_REQUIRED');
    });

    /**
     * **400, not 401** — roadmap F22's second half. A signed-in caller told *you need to sign in* is
     * sent to fix the wrong thing, and the console rendered exactly that sentence to somebody who
     * was signed in.
     */
    it('is not told to sign in, because it is signed in', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.stranger);
        expect(answer.status).not.toBe(401);
        expect(JSON.stringify(answer.body)).not.toMatch(/sign in/i);
    });

    /** Naming an organization it does not belong to is *not found*, never *forbidden*: which
     *  organizations exist is not something a caller gets to confirm by probing. */
    it('cannot reach an organization by naming it', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.stranger, world.tenantOrg);

        expect(answer.status).toBe(404);
        expect((answer.body as { error: string }).error).toBe('no_such_organization');
    });
});

describe.skipIf(!reachable)('an anonymous caller', () => {
    it('is refused a `user` contract with 401', async () => {
        const answer = await request(port(), 'GET', '/api/sites', { host: TENANT_HOST });
        expect(answer.status).toBe(401);
        expect((answer.body as { error: string }).error).toBe('UNAUTHENTICATED');
    });

    it('may still reach the two calls that let somebody sign in', async () => {
        const issued = await request(port(), 'POST', '/api/identity/ticket', {
            host: TENANT_HOST, body: { email: world.owner.email, password: 'owner-password-1' },
        });
        expect(issued.status).toBe(200);
    });
});

describe.skipIf(!reachable)('a tenant owner, who belongs to one organization', () => {
    it('reads its own sites on its own hostname', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.owner);

        expect(answer.status).toBe(200);
        expect(tenantsIn(answer.body)).toEqual([world.tenantOrg]);
    });

    /**
     * **On somebody else's hostname it still sees only its own**, which is the property that makes
     * a shared console safe to point at: the scope comes from the caller's memberships, and the
     * site can only ever choose *among* them.
     */
    it('sees nothing of the platform\'s on the platform\'s hostname', async () => {
        const answer = await sitesOn(PLATFORM_HOST, () => world.owner);

        expect(answer.status).toBe(200);
        expect(tenantsIn(answer.body)).toEqual([world.tenantOrg]);
    });

    it('is refused an operator contract, with 403 rather than 401', async () => {
        const answer = await request(port(), 'POST', `/api/sites/${TENANT_HOST}/deploy`, {
            host: TENANT_HOST, ticket: world.owner.ticket, body: { releaseHash: 'sha256:whatever' },
        });

        // 403 and not 401: a valid ticket that is not an operator's is a different answer to a
        // different question, and a screen that conflates them sends somebody to sign in again.
        expect(answer.status).toBe(403);

        // And owning the organization that owns the hostname is not operator standing either.
        // Deploying changes what runs on a hostname, which `gateFor` reserves deliberately —
        // roadmap F27 is that the same reservation is applied to the *application's* own writes,
        // where it does not belong.
        expect((answer.body as { message?: string }).message ?? '').toMatch(/operator/i);
    });

    /**
     * **Roadmap F28.** A password change is a write, matched none of `gateFor`'s read patterns, and
     * fell to the `operator` default — so on every seeded site a person was refused their own
     * password and only the cluster operator could change it. The contract takes no subject id
     * precisely because the caller *is* the subject.
     */
    it('may change its own password, and the old ticket dies with it', async () => {
        const changed = await request(port(), 'POST', '/api/identity/password', {
            host: TENANT_HOST, ticket: world.owner.ticket, body: { password: 'owner-password-2' },
        });
        expect(changed.status).toBe(200);

        const stale = await sitesOn(TENANT_HOST, () => world.owner);
        expect(stale.status).toBe(401);

        world.owner.ticket = await signIn(world.owner.email, 'owner-password-2', TENANT_HOST);
        expect((await sitesOn(TENANT_HOST, () => world.owner)).status).toBe(200);
    });
});

/**
 * **The same account, two hostnames, two answers — roadmap F22.**
 *
 * Seeding a second tenant makes the operator an owner of both organizations, and from that moment
 * every scoped read with no `x-organization` header resolved no scope at all and answered 401. The
 * console rendered it as *"You need to sign in"* to somebody who was signed in.
 */
describe.skipIf(!reachable)('an operator who belongs to two organizations', () => {
    it('means the platform on the platform\'s hostname', async () => {
        const answer = await sitesOn(PLATFORM_HOST, () => world.operator);

        expect(answer.status).toBe(200);
        expect(tenantsIn(answer.body)).toEqual([world.platformOrg]);
        expect((answer.body as unknown[]).length).toBe(2);
    });

    it('means the tenant on the tenant\'s hostname', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.operator);

        expect(answer.status).toBe(200);
        expect(tenantsIn(answer.body)).toEqual([world.tenantOrg]);
    });

    /** The header is for acting somewhere other than where you arrived, and it wins over the site. */
    it('may name the other one explicitly, from either hostname', async () => {
        const answer = await sitesOn(TENANT_HOST, () => world.operator, world.platformOrg);

        expect(answer.status).toBe(200);
        expect(tenantsIn(answer.body)).toEqual([world.platformOrg]);
    });

    /**
     * The property that makes the hostname safe to read a scope from: it chooses **among** the
     * caller's memberships and can never add one. An operator naming an organization it does not
     * belong to gets the stranger's answer, platform role and all.
     */
    it('cannot name an organization it does not belong to', async () => {
        const answer = await sitesOn(PLATFORM_HOST, () => world.operator, 'org-nobody-is-in');

        expect(answer.status).toBe(404);
        expect((answer.body as { error: string }).error).toBe('no_such_organization');
    });
});
