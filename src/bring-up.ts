/**
 * Seed a running cluster: a user, an organization, a membership, and a site.
 *
 * **It joins; it does not load a database.** This used to mount `DatabaseModule`, identity and the
 * cdn in-process and write rows directly, which is a second path into the same collections — one
 * that skips the publisher checks, the scope checks and the invariants the contracts exist to
 * enforce. Whatever it seeded was therefore not necessarily something the platform would have
 * accepted from a real caller, which is the opposite of what a bring-up script is for.
 *
 * So it does what `mesh stats` and `mesh-serve publish` do: joins as a **temporary node** with no
 * database and no modules of its own, waits for the tools it needs to appear, calls them, and
 * leaves. Everything it writes went through the same door a browser uses.
 *
 * ```
 * node bin/node.mjs …            # the cluster, holding the database
 * npx tsx src/bring-up.ts        # this, dialling in on the default port
 * ```
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BrokerModule,
    JSONSerializer,
    MeshApp,
    NetworkModule,
    RegistryModule,
    type IServiceBroker,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

/**
 * The mesh handshake key comes from `.env`, like everything else a node needs.
 *
 * Not from a command line: a value typed as `MESH_KEY=… npx tsx …` is visible in `ps` to every user
 * on the machine and lands in a shell history. `bin/node.mjs` reads the same file for the same
 * reason, and a joiner whose key does not match the cluster's is refused at the transport.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
    // No `.env` is fine: a loopback cluster started without a key needs none, and an already
    // exported value wins anyway.
}

/** Where the cluster is. The node's own default ws port, so the common case needs no flag. */
const DEFAULT_BOOTSTRAP = 'ws://127.0.0.1:4001';

export interface BringUpContext {
    app: MeshApp;
    broker: IServiceBroker;
    /** Block until a tool is reachable on the mesh, so a call cannot race the node it needs. */
    waitFor(tool: string, ms?: number): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Join the cluster as a temporary node.
 *
 * `port: 0` because this node dials out and nothing dials it — it is a peer that happens to be
 * short-lived rather than a client, which is what lets every contract it calls be an ordinary
 * contract with no second, script-shaped entrance.
 */
export async function setup(options: { bootstrap?: readonly string[] } = {}): Promise<BringUpContext> {
    const configured = options.bootstrap
        ?? (flag('bootstrap', process.env['MESH_BOOTSTRAP'] ?? DEFAULT_BOOTSTRAP))
            .split(',').map((node) => node.trim()).filter((node) => node !== '');

    const app = new MeshApp({
        nodeID: `bringup-${os.hostname()}-${Date.now().toString(36)}`,
    });

    app.use(new RegistryModule());
    app.use(new NetworkModule({
        port: 0,
        transports: [new WSTransport(new JSONSerializer(), 0)],
        bootstrapNodes: [...configured],
    }));
    app.use(new BrokerModule());

    await app.start();

    const broker = app.getProvider<IServiceBroker>('broker');

    return {
        app,
        broker,
        waitFor: (tool, ms = 10_000) => app.registry.waitForTool(tool, ms),
        stop: () => app.stop(),
    };
}

export async function main(): Promise<void> {
    const ctx = await setup();
    const { broker, waitFor } = ctx;

    try {
        console.log('\n=== Seeding the cluster through its own contracts ===\n');

        // Nothing below can run until identity is actually reachable. Without this the first call
        // fails with "tool not found" a few milliseconds before the node it needs finishes
        // announcing itself, which reads as a broken cluster rather than as a race.
        await waitFor('identity.ticket_issue');

        // 1. The user
        const email = flag('email', process.env['USER_EMAIL'] ?? 'tim@example.com');
        const password = flag('password', process.env['USER_PASSWORD'] ?? 'correct-horse-battery-staple');
        const displayName = flag('name', process.env['USER_NAME'] ?? 'Tim');

        let userId: string;
        const existingUser = await broker.call('user.find_one', { query: { email } })
            .catch(() => null);

        if (existingUser?.id !== undefined) {
            userId = existingUser.id;
            console.log(`[user] "${email}" already exists (${userId})`);
        } else {
            const registered = await broker.call('identity.register', { email, password, displayName });
            userId = registered.userId;
            console.log(`[user] registered "${email}" (${userId})`);
        }

        // 2. The organization
        const orgSlug = flag('org-slug', process.env['ORG_SLUG'] ?? 'tim-org');
        const orgName = flag('org-name', process.env['ORG_NAME'] ?? 'Tim Org');

        let orgId: string;
        const existingOrg = await broker.call('organization.find_one', { query: { slug: orgSlug } })
            .catch(() => null);

        if (existingOrg?.id !== undefined) {
            orgId = existingOrg.id;
            console.log(`[org] "${orgSlug}" already exists (${orgId})`);
        } else {
            const org = await broker.call('organization.create', {
                name: orgName, slug: orgSlug, ownerId: userId,
            });
            orgId = org.id;
            console.log(`[org] created "${orgName}" (${orgSlug}) (${orgId})`);
        }

        // 3. The membership, which is what makes the user's calls resolve to that organization.
        const orgMeta = {
            meta: {
                organizationId: orgId,
                tenantId: orgId,
                user: { id: userId, tenant_id: orgId },
            },
        };

        // **Both halves of the key.** Querying on `userId` alone matches a membership in *some*
        // organization, so a user who belongs to two would be reported as already a member of
        // whichever row came back first — and never added to this one.
        const existingMember = await broker.call(
            'membership.find_one',
            { query: { userId, organizationId: orgId } },
            orgMeta,
        ).catch(() => null);

        if (existingMember?.id !== undefined) {
            console.log(`[membership] already an owner of "${orgSlug}"`);
        } else {
            await broker.call('membership.create', {
                userId, organizationId: orgId, roleKey: 'owner', joinedAt: Date.now(),
            }, orgMeta);
            console.log(`[membership] added ${userId} as owner of "${orgSlug}"`);
        }

        // 4. A ticket, so the rest of the seeding — and whatever the operator does next — is a
        //    call from a real caller rather than from a script with a private door.
        const ticket = await broker.call('identity.ticket_issue', { email, password });

        // 5. The site
        const siteHost = flag('host', process.env['SITE_HOST'] ?? 'localhost');
        const siteApi = flag('api', process.env['SITE_API'] ?? 'http://127.0.0.1:5005');

        await waitFor('site.find_one');
        const existingSite = await broker.call('site.find_one', { query: { host: siteHost } }, orgMeta)
            .catch(() => null);

        if (existingSite?.id !== undefined) {
            console.log(`[site] "${siteHost}" already exists (${existingSite.id})`);
        } else {
            const site = await broker.call('site.create', {
                host: siteHost,
                application: 'console',
                tenantId: orgId,
                api: siteApi,
                mesh: [{
                    package: '@flybyme/mesh-serve',
                    version: '^0.1.0',
                    contracts: [
                        { key: 'identity.register', auth: 'public' },
                        { key: 'identity.ticket_issue', auth: 'public' },
                        { key: 'identity.whoami', auth: 'user' },
                        { key: 'site.find', auth: 'user' },
                        { key: 'site.get', auth: 'user' },
                    ],
                    events: [],
                }],
                theme: {},
                policy: {},
                title: 'Console Site',
            }, orgMeta);
            console.log(`[site] created "${siteHost}" (${site.id})`);
        }

        console.log('\n=== Done ===\n');
        console.log(`User:  ${email}`);
        console.log(`Org:   ${orgName} (${orgSlug}) [${orgId}]`);
        console.log(`Site:  ${siteHost} → ${siteApi}\n`);

        /**
         * The ticket is printed and the password is not.
         *
         * A ticket expires and can be revoked; a password is the credential behind every ticket
         * that will ever be issued for this account, and printing one puts it in a scrollback, a
         * screen recording and a `journalctl` for as long as any of those live. Same class of
         * mistake as the database password that reached surf's journal.
         */
        console.log(`Ticket: ${ticket.token}\n`);
        console.log('Try it:');
        console.log(
            `  curl -H "Host: ${siteHost}" -H "Authorization: Bearer ${ticket.token}" ` +
            `${siteApi}/identity/whoami\n`,
        );
    } finally {
        await ctx.stop();
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error: unknown) => {
        console.error('Bring-up failed:', error);
        process.exit(1);
    });
}
