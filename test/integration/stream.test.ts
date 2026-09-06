/**
 * Subscriptions, against a real everything.
 *
 * The rule everything here serves: **an event that cannot be scoped is delivered to nobody.** It
 * replaced a version that read a payload/contract disagreement as *"unscoped, send to everybody"*,
 * which put one organization's data on every connected browser — and the reason that survived is
 * that it looked like it worked.
 *
 * So the assertions are mostly about what does **not** arrive, which is the hard thing to test and
 * the only thing worth testing here.
 */

import {
    BrokerModule, DatabaseModule, defineEvent, MeshApp, RegistryModule, z,
} from '@flybyme/mesh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiService, EVENTS_PATH } from '../../src/api/api.service.js';
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
    } catch { return false; }
})();

/**
 * Two events with different scopes, defined here so the registry has something real to resolve.
 *
 * `zone_created` names the organization it belongs to. `orphan_created` does not, and it exists to
 * prove that an event nobody can narrow is refused rather than streamed.
 */
const zoneCreated = defineEvent('domains.zone_created', z.object({
    organizationId: z.string(),
    zone: z.string(),
}), { scopedBy: 'organizationId' });

const orphanCreated = defineEvent('domains.orphan_created', z.object({ zone: z.string() }));

const ORG = 'org-a';
const OTHER = 'org-b';
const HOST = 'stream.test';

let app: MeshApp;
let api: ApiService;
let ticket: string;

/** Read an SSE stream for a while, then hang up and report what arrived. */
async function listen(
    port: number,
    options: { host?: string; ticket?: string; forMs?: number; onOpen?: () => void },
): Promise<{ status: number; frames: string[] }> {
    const { request } = await import('node:http');

    return new Promise((resolve, reject) => {
        const req = request({
            host: '127.0.0.1', port, path: `/api${EVENTS_PATH}`, method: 'GET',
            headers: {
                host: options.host ?? HOST,
                ...(options.ticket === undefined ? {} : { authorization: `Bearer ${options.ticket}` }),
            },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { text += chunk; });

            if (res.statusCode !== 200) {
                res.on('end', () => { resolve({ status: res.statusCode ?? 0, frames: [text] }); });
                return;
            }

            // The stream never ends on its own, so emit into it and then hang up.
            setTimeout(() => { options.onOpen?.(); }, 40);
            setTimeout(() => {
                req.destroy();
                resolve({
                    status: 200,
                    frames: text.split('\n\n').filter((f) => f.trim() !== ''),
                });
            }, options.forMs ?? 260);
        });

        req.on('error', (error: NodeJS.ErrnoException) => {
            // Our own destroy(), which is how a subscription ends here.
            if (error.code === 'ECONNRESET') return;
            reject(error);
        });
        req.end();
    });
}

const call = <T,>(tool: string, params: unknown, tenant = ORG): Promise<T> =>
    (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<T> })
        .call(tool, params, { meta: { user: { id: 'u1', tenant_id: tenant } } });

beforeAll(async () => {
    if (!reachable) return;

    app = new MeshApp({
        nodeID: `stream-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-serve-stream',
    });
    app.use(new RegistryModule());
    app.use(new DatabaseModule({ uri: MONGO, dbName: `mesh-serve-stream-${String(Date.now())}` }));
    app.use(new BrokerModule());
    await app.start();

    /**
     * A site's answer to *in which organization*.
     *
     * Not optional for a site that streams scoped events, and the api now refuses a subscription
     * rather than opening one that can never deliver: the coarse gate cannot resolve a scope, because
     * only a site knows what an organization means to it.
     *
     * This one is deliberately simple — everybody acts in `org-a` — because what is under test is
     * delivery, not membership.
     */
    api = new ApiService({
        port: 0,
        authorize: ({ caller, requestedScope }) => (caller === undefined
            ? { authorized: false }
            : { authorized: true, resolvedScope: requestedScope ?? ORG }),
    });
    await app.registerModule(new CdnService({ port: 0 }));
    await app.registerModule(createIdentityModule({ store: memoryStore() }));
    await app.registerModule(api);

    await call('site.create', {
        host: HOST, application: 'test', tenantId: ORG, api: '/api',
        mesh: [{
            package: '@flybyme/surfdns-domains',
            version: '^1.0',
            contracts: [{ key: 'identity.whoami', auth: 'user' }],
            events: [{ key: zoneCreated.name, auth: 'user' }],
        }],
        theme: {}, policy: {}, title: 'Stream test',
    });

    await call('identity.register', {
        email: 'alice@example.com', password: 'correct horse', displayName: 'Alice',
    });
    ticket = (await call<{ token: string }>('identity.ticket_issue', {
        email: 'alice@example.com', password: 'correct horse',
    })).token;
}, 60_000);

afterAll(async () => {
    if (!reachable || app === undefined) return;
    await app.stop();
});

const port = (): number => api.port!;

describe.skipIf(!reachable)('opening a subscription', () => {
    it('refuses an anonymous caller, because the events are gated `user`', async () => {
        const answer = await listen(port(), {});
        expect(answer.status).toBe(401);
    });

    it('opens for a caller with a ticket, and says so before any event', async () => {
        // A client's `onopen` fires on the first byte. Without the comment frame a subscription to a
        // quiet stream is indistinguishable from a connection that never established.
        const answer = await listen(port(), { ticket, forMs: 120 });

        expect(answer.status).toBe(200);
        expect(answer.frames[0]).toContain(': open');
    });

    it('404s a hostname nobody configured', async () => {
        const answer = await listen(port(), { host: 'nobody.test', ticket });
        expect(answer.status).toBe(404);
    });
});

describe.skipIf(!reachable)('what arrives', () => {
    it('delivers an event scoped to the subscriber', async () => {
        const answer = await listen(port(), {
            ticket,
            onOpen: () => {
                api.deliver(zoneCreated.name, { organizationId: ORG, zone: 'example.com' });
            },
        });

        expect(answer.frames.some((f) => f.includes('example.com'))).toBe(true);
        expect(answer.frames.some((f) => f.includes(`event: ${zoneCreated.name}`))).toBe(true);
    });

    it('does not deliver another organization\'s event', async () => {
        // The whole point. This subscriber is in org-a and the payload belongs to org-b, and
        // *nothing about the connection changes* — it stays open and simply does not receive it.
        const answer = await listen(port(), {
            ticket,
            onOpen: () => {
                api.deliver(zoneCreated.name, { organizationId: OTHER, zone: 'not-yours.com' });
            },
        });

        expect(answer.status).toBe(200);
        expect(answer.frames.some((f) => f.includes('not-yours.com'))).toBe(false);
    });

    it('does not deliver a payload missing its scope field', async () => {
        // The contract and the payload disagree. The old reading was "unscoped, send to everybody";
        // the safe reading of a disagreement is nobody.
        const answer = await listen(port(), {
            ticket,
            onOpen: () => {
                api.deliver(zoneCreated.name, { zone: 'malformed.com' });
            },
        });

        expect(answer.frames.some((f) => f.includes('malformed.com'))).toBe(false);
    });

    it('does not deliver an event this site never exposed', async () => {
        // Reaching `offer` at all means the broker delivered something nobody subscribed to.
        const answer = await listen(port(), {
            ticket,
            onOpen: () => {
                api.deliver('domains.something_else', { organizationId: ORG, zone: 'other.com' });
            },
        });

        expect(answer.frames.some((f) => f.includes('other.com'))).toBe(false);
    });
});

describe.skipIf(!reachable)('an event that cannot be narrowed', () => {
    it('is refused at subscribe time rather than streamed silently', async () => {
        // `orphan_created` declares no scopedBy, so `decideDelivery` would answer `unscopable` for
        // every payload forever. A subscription that connects and never delivers is the hardest
        // failure here to tell from a working one, so it is refused with a reason instead.
        const other = 'orphan.test';
        await call('site.create', {
            host: other, application: 'test', tenantId: ORG, api: '/api',
            mesh: [{
                package: 'p', version: '1',
                contracts: [{ key: 'identity.whoami', auth: 'user' }],
                events: [{ key: orphanCreated.name, auth: 'user' }],
            }],
            theme: {}, policy: {}, title: 'Orphan',
        });

        const answer = await listen(port(), { host: other, ticket });

        expect(answer.status).toBe(404);
        expect(answer.frames[0]).toContain('scopedBy');
    });
});

/**
 * The events this repository actually emits, checked against the rule the suite above enforces.
 *
 * Every one of the four declared no `scopedBy` until 2026-09-06, which meant `decideDelivery`
 * answered `unscopable` for all of them and the api refused every subscription — so a build monitor
 * or a live deploy view was impossible, not merely unbuilt (roadmap F1).
 *
 * This is a unit test on the contracts rather than a stream test, because the property is a property
 * of the declarations: an event that cannot be scoped cannot be delivered, and finding that out at
 * subscribe time in a browser is finding out far too late.
 */
describe('every event this repository emits can actually be delivered', () => {
    it('declares a scope on all four', async () => {
        const [{ siteDeployedEvent }, { releaseComposedEvent }, { versionPublishedEvent },
            { artifactPublishedEvent }] = await Promise.all([
            import('../../src/cdn/contracts/site.contract.js'),
            import('../../src/cdn/contracts/release.contract.js'),
            import('../../src/catalog/contracts/part.contract.js'),
            import('../../src/builder/contracts/artifact.contract.js'),
        ]);

        for (const event of [siteDeployedEvent, releaseComposedEvent,
            versionPublishedEvent, artifactPublishedEvent]) {
            expect(event.scopedBy, `${event.name} has no scopedBy`).toBeDefined();
        }
    });

    it('carries the field it says it is scoped by', async () => {
        // The half that a `scopedBy` alone does not give you. Two of these payloads had no tenant
        // field at all — they were written for another *service* to consume, and a service already
        // holds the record. Declaring a scope over a field the payload does not carry would be
        // `unscopable` at run time with a green test suite.
        const { siteDeployedEvent } = await import('../../src/cdn/contracts/site.contract.js');
        const { releaseComposedEvent } = await import('../../src/cdn/contracts/release.contract.js');

        for (const event of [siteDeployedEvent, releaseComposedEvent]) {
            expect(event.scopedBy).toBe('tenantId');
            const shape = (event.schema as unknown as { shape: Record<string, unknown> }).shape;
            expect(shape['tenantId'], `${event.name} is scoped by a field it does not carry`)
                .toBeDefined();
        }
    });
});
