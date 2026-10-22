/**
 * A mailbox signed in with its own address and password, over real HTTP (owner, 10-19: the webmail
 * at mail.<platform> -- "They sign in with their email ... Not the same as the console").
 *
 * The mail service validates its sessions (`mailbox.session_validate`, stood in here), as any part
 * may for its own (`<domain>.session_validate`). A mailbox is no account: it acts only in its own
 * organization, passes only gates asking for `mailbox` alone, and its call carries the session's
 * fields (which mailbox), so the webmail's tools act on that one alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
    BrokerModule, DatabaseModule, defineContract, defaultPrint, defineCrud, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule,
    PlacementRegistry, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { CATALOG_DOMAINS } from '../src/catalog/domains.js';
import { resolveHandler } from '../src/catalog/methods/resolveHandler.js';
import '../src/identity/contracts/user.contract.js';
import '../src/identity/contracts/organization.contract.js';
import '../src/identity/contracts/membership.contract.js';
import '../src/identity/contracts/role.contract.js';
import '../src/identity/contracts/ticket.contract.js';
import '../src/identity/contracts/apiToken.contract.js';
import '../src/identity/contracts/identity.contract.js';
import '../src/api/contracts/api.contract.js';
import '../src/api/contracts/expose.contract.js';
import { hashPassword } from '../src/identity/methods/hash.js';
import { ensureBootstrapApi } from '../src/api/ensureBootstrapApi.js';

const DB_NAME = 'mesh-serve-mailbox-integration-test';
const WS_PORT = 16611;
const API_PORT = 15611;
const ORIGIN = `http://api.localhost:${API_PORT}`;
const PASSWORD = 'a-real-password-for-tests-12';

declare global {
    interface IServiceToolRegistry {
        'mailbox.session_validate': { params: { token: string }; returns: SessionReply };
        'rogue.session_validate': { params: { token: string }; returns: SessionReply };
        'mailboxtest.whoami': { params: Record<string, never>; returns: { id: string; tenant: string; mailAddressId: string; mailAddress: string } };
    }
}

/** What a part's `<domain>.session_validate` answers (api/gateway.ts `sessionOf`). */
const sessionReplySchema = z.object({
    valid: z.boolean(), role: z.string().optional(), subjectId: z.string().optional(), organizationId: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
});
type SessionReply = z.infer<typeof sessionReplySchema>;

/** A part's session validator, stood in: the mail service's, and a rogue one claiming an account's role. */
const sessionValidateContract = (domain: string) => defineContract({
    domain, action: 'session_validate', description: `test: a ${domain} session`,
    inputSchema: z.object({ token: z.string() }),
    outputSchema: sessionReplySchema,
    rest: { method: 'POST', path: `/${domain}/session_validate` }, filePath: 'test/mailbox.integration.test.ts',
    concurrency: 'on-demand', permissions: [], visibility: 'internal', print: defaultPrint,
});

/** A webmail call: gated on the mailbox alone, answering whom it ran for. */
const whoamiContract = defineContract({
    domain: 'mailboxtest', action: 'whoami', description: 'test: who a mailbox call runs as',
    inputSchema: z.object({}),
    outputSchema: z.object({ id: z.string(), tenant: z.string(), mailAddressId: z.string(), mailAddress: z.string() }),
    rest: { method: 'GET', path: '/mailboxtest/whoami' }, filePath: 'test/mailbox.integration.test.ts',
    concurrency: 'on-demand', permissions: ['mailbox'], visibility: 'public', print: defaultPrint,
});

/** A member's collection: never a mailbox's. */
const noteCrud = defineCrud('mailboxNote', z.object({ tenantId: z.string(), name: z.string() }), {
    pluralPath: 'mailboxNotes', scopedBy: 'tenantId', visibility: { find: 'public' }, dependencies: [],
    filePath: 'test/mailbox.integration.test.ts', permissions: ['member'],
});

describe('a mailbox signed in with its own password', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    const orgId: Record<string, string> = {};
    let ada = '';
    const MAILBOX_TOKEN = 'mbx-session-token-for-info';
    const ROGUE_TOKEN = 'rogue-session-claiming-operator';
    const ROGUE_FIELDS_TOKEN = 'rogue-session-setting-id';

    const call = async (path: string, token: string, organization?: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`${ORIGIN}/api${path}`, {
            headers: { authorization: `Bearer ${token}`, ...(organization !== undefined ? { 'x-organization': organization } : {}) },
        });
        return { status: res.status, body: await res.json() };
    };

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
        const client = new MongoClient(uri);
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
        process.env.API_PORT = String(API_PORT);

        app = new MeshApp({ nodeID: 'mailbox-node', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri, dbName: DB_NAME }));
        app.use(new BrokerModule());
        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        await broker.loadDomain('identity', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.api', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.expose', {}, { resolve: resolveHandler });
        await broker.loadDomain('serve.activity', {}, { resolve: resolveHandler });
        await broker.call('identity.role.ensureBuiltins', {});
        broker.registerCrud(noteCrud);

        const user = async (key: string, roles: string[]): Promise<string> => (await broker.call('identity.user.create', {
            email: `${key}@mailbox.invalid`, displayName: key, passwordHash: await hashPassword(PASSWORD), roles, provisional: false,
        })).id;
        const operator = await user('operator', ['operator']);
        ada = await user('ada', []);
        orgId.platform = (await broker.call('identity.organization.create', { slug: 'platform', name: 'Platform', ownerId: operator })).id;
        orgId.peera = (await broker.call('identity.organization.create', { slug: 'peera', name: 'Peera', ownerId: ada })).id;
        orgId.other = (await broker.call('identity.organization.create', { slug: 'other', name: 'Other', ownerId: operator })).id;

        broker.registerContract(sessionValidateContract('mailbox'), async (input) => (input.token === MAILBOX_TOKEN
            ? { valid: true, role: 'mailbox', subjectId: 'mbx-info', organizationId: orgId.peera ?? '', fields: { mailAddressId: 'mbx-info', mailAddress: 'info@peera.example' } }
            : { valid: false }));
        // A part may not mint an account's role, nor set who the call is.
        broker.registerContract(sessionValidateContract('rogue'), async (input) => (input.token === ROGUE_TOKEN
            ? { valid: true, role: 'operator', subjectId: 'x', organizationId: orgId.platform ?? '' }
            : input.token === ROGUE_FIELDS_TOKEN
                ? { valid: true, role: 'rogue', subjectId: 'y', organizationId: orgId.platform ?? '', fields: { id: 'someone-else' } }
                : { valid: false }));
        broker.registerContract(whoamiContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            const field = (key: string): string => {
                const value = typeof user === 'object' && user !== null ? Reflect.get(user, key) : undefined;
                return typeof value === 'string' ? value : '';
            };
            return { id: field('id'), tenant: field('tenant_id'), mailAddressId: field('mailAddressId'), mailAddress: field('mailAddress') };
        });

        await ensureBootstrapApi(broker);
        const api = await broker.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
        if (api === undefined) throw new Error('bootstrap api was not created');
        const meta = { meta: { tenant_id: orgId.platform } };
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'mailboxtest.whoami' }, meta);
        await broker.call('serve.expose.add', { apiId: api.id, contract: 'mailboxNote.find', role: 'member' }, meta);
        await broker.callNamed('mailboxNote.create', { tenantId: orgId.peera, name: 'peera-note' }, { meta: { tenant_id: orgId.peera } });
    }, 40000);

    afterAll(async () => {
        await app.stop();
        const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
        await client.connect();
        await client.db(DB_NAME).dropDatabase();
        await client.close();
    });

    it('runs a webmail call in its own organization, saying which mailbox', async () => {
        expect(await call('/mailboxtest/whoami', MAILBOX_TOKEN)).toEqual({
            status: 200,
            body: { id: 'mailbox:mbx-info', tenant: orgId.peera, mailAddressId: 'mbx-info', mailAddress: 'info@peera.example' },
        });
    });

    it('is refused every member call, even of its own organization', async () => {
        const res = await call('/mailboxNotes', MAILBOX_TOKEN);
        expect(res.status).toBe(403);
    });

    it('can never name another organization', async () => {
        expect((await call('/mailboxtest/whoami', MAILBOX_TOKEN, orgId.other)).status).toBe(403);
        expect((await call('/mailboxtest/whoami', MAILBOX_TOKEN, orgId.peera)).status).toBe(200);
    });

    it('a token the mail service does not know is no one', async () => {
        expect((await call('/mailboxtest/whoami', 'not-a-session')).status).toBe(401);
    });

    it('a session claiming an account\'s role, or setting who the call is, is no one', async () => {
        expect((await call('/mailboxNotes', ROGUE_TOKEN)).status).toBe(401);
        expect((await call('/mailboxNotes', ROGUE_FIELDS_TOKEN)).status).toBe(401);
    });

    it('a console member is not a mailbox: the webmail call refuses them', async () => {
        const res = await fetch(`${ORIGIN}/api/identity/ticket`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'ada@mailbox.invalid', password: PASSWORD }),
        });
        const ticket = (await res.json() as { token: string }).token;
        expect((await call('/mailboxtest/whoami', ticket)).status).toBe(403);
        expect((await call('/mailboxNotes', ticket)).status).toBe(200);
    });
});
