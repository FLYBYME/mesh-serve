#!/usr/bin/env node
/**
 * A mesh-serve node.
 *
 * One process running all five services, reachable over the mesh and over HTTP. Not a deployment
 * story — that is the fleet's job, and it is unbuilt — but the thing that has been missing while
 * every service in this repository could only be exercised by a test that constructed it.
 *
 * ```
 * node bin/node.mjs --ws 4001 --cdn 8080 --api 5005 --db mesh-serve-live
 * ```
 *
 * Configuration comes from a `.env` beside the checkout, or `/etc/mesh/node.env`. Flags override it
 * for ports and paths; secrets are only ever in the file. See `docs/operating.md`.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
    globalContractRegistry,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiService } from '../dist/api/api.service.js';
import { FleetService } from '../dist/fleet/fleet.service.js';
// The one list. `reconcileNode` reads it too and treats these as permanently satisfied; two copies
// would disagree the day somebody adds a fourth, and the symptom is a node that cannot converge.
import { CORE_SERVICES } from '../dist/fleet/schema/node.js';
import { Supervisor } from '../dist/supervisor/Supervisor.js';
import { SupervisorService } from '../dist/supervisor/SupervisorService.js';

// Manifest paths are resolved against this, so `./dist/...` means this repository wherever it is
// checked out — not the directory somebody happened to run the command from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { createIdentityModule, mongoStore } from '../dist/identity/index.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
};

/**
 * Configuration comes from a file, not from the command line.
 *
 * **A node is started by systemd, or by a person who ssh'd into the box** — and in both cases
 * typing `MESH_KEY=… MONGODB_URI=… node bin/node.mjs …` is wrong twice over. Every value is visible
 * in `ps` to anyone on the machine, and the invocation is different on every host, so nobody can
 * say what a node is actually running with except by reading somebody's shell history.
 *
 * So the node reads its own `.env`, in this order, first match wins:
 *
 *   1. `--env <path>`
 *   2. `MESH_ENV_FILE`
 *   3. `./.env` beside the checkout — what a person working in the directory expects
 *   4. `/etc/mesh/node.env` — what systemd uses
 *
 * **The real environment always wins.** A value already exported is never overwritten, so a
 * one-off `MESH_KEY=… node bin/node.mjs` still works for a quick experiment, and systemd's
 * `EnvironmentFile` is not fighting a file the node also reads.
 *
 * This is deliberately not `dotenv`: one dependency, forty lines, for a format that is four rules.
 */
const loadEnvFile = () => {
    const candidates = [
        flag('env', undefined),
        process.env.MESH_ENV_FILE,
        path.join(repoRoot, '.env'),
        '/etc/mesh/node.env',
    ].filter((p) => p !== undefined);

    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;

        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) continue;

            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;

            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();

            // Quotes are stripped, because a URI with a `?` in it is one somebody will quote.
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            // Never overwrite. The environment is the more specific answer.
            if (process.env[key] === undefined) process.env[key] = value;
        }

        return file;
    }

    return undefined;
};

const envFile = loadEnvFile();

const wsPort = Number(flag('ws', '4001'));
const wsHost = flag('ws-host', '127.0.0.1');
const cdnPort = Number(flag('cdn', '8080'));
const cdnUrl = flag('cdn-url', process.env.CDN_URL ?? `http://127.0.0.1:${String(cdnPort)}`);
const apiPort = Number(flag('api', '5005'));
const mongo = flag('mongo', process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
const dbName = flag('db', 'mesh-serve');
const blobRoot = flag('artifacts', process.env.MESH_BLOB_ROOT ?? './.artifacts');
const bootstrap = (flag('bootstrap', process.env.MESH_BOOTSTRAP ?? '') || '')
    .split(',').map((n) => n.trim()).filter((n) => n !== '');

/**
 * Say where the credential is going, without printing it.
 *
 * Hoisted above the banner because the pre-flight below needs it too — a diagnostic that leaks the
 * password while explaining why the password did not work would be its own incident.
 */
const safeUri = (uri) => uri.replace(/^(\w+(?:\+\w+)?:\/\/)([^@/]*)@/, (_all, scheme, userinfo) =>
    `${scheme}${String(userinfo).split(':')[0]}:***@`);

/**
 * **Connect once, quickly, and say what went wrong.**
 *
 * `DatabaseModule` builds `new MongoClient(uri)` with no options, so it inherits the driver's
 * 30-second server-selection default and prints nothing at all while it waits. Pointing a node at
 * Atlas for the first time therefore looks exactly like a hang: `Starting module: database`, then
 * half a minute of silence, then a stack trace — and the stack trace names `MongoServerSelectionError`,
 * which is the same message for a wrong password, an unlisted IP and a typo in the hostname.
 *
 * Those three have completely different fixes and only one of them is in this repository, so this
 * asks first, with a short timeout, and translates the answer. It changes nothing about how the
 * node connects — `DatabaseModule` still opens its own client immediately afterwards — it just
 * makes the ten seconds before a failure informative instead of blank.
 */
async function preflightDatabase(uri, name) {
    process.stdout.write(`connecting to ${safeUri(uri)}/${name} ... `);

    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

    try {
        await client.connect();
        await client.db(name).command({ ping: 1 });
        process.stdout.write('ok\n');
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write('FAILED\n\n');

        // Each branch is a different person's problem: the first two are in the Atlas console, the
        // third is in `.env`, and only the last is worth reading a stack trace over.
        if (/bad auth|Authentication failed/i.test(message)) {
            process.stderr.write(
                `The cluster answered and refused the credential.\n` +
                `  · check the username and password in ${envFile ?? '.env'}\n` +
                `  · a password with @ : / or ? in it must be percent-encoded in a URI\n`,
            );
        } else if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(message)) {
            process.stderr.write(
                `The cluster hostname did not resolve, so nothing was contacted.\n` +
                `  · check the host in MONGODB_URI against the Atlas connect dialog\n` +
                `  · mongodb+srv:// needs working DNS SRV lookups from this machine\n`,
            );
        } else if (/ECONNREFUSED/i.test(message)) {
            /**
             * **Refused is not the same as ignored**, and saying so is the whole value of this.
             *
             * Something answered and said no, which means the address and the port are right and
             * nothing is listening there. A firewall or an allowlist does not refuse — it drops,
             * and that is the branch below. Leading with *"check the IP allowlist"* here would send
             * somebody to the Atlas console over a mongo they forgot to start.
             */
            process.stderr.write(
                `Nothing is listening there — the connection was refused, not dropped.\n` +
                `  · start the database, or check the host and port in MONGODB_URI\n` +
                `  · a container that exited looks exactly like this\n`,
            );
        } else if (/ServerSelection|timed out|ETIMEDOUT/i.test(message)) {
            process.stderr.write(
                `The cluster did not answer within 10s — dropped rather than refused, which is what\n` +
                `a firewall does. **On Atlas this is almost always the IP allowlist.**\n` +
                `  · Atlas → Network Access → add this machine's current address\n` +
                `  · a home or office address changes; one that worked last week may not now\n`,
            );
        } else {
            process.stderr.write(`${message}\n`);
        }

        process.stderr.write(`\n${message}\n`);
        return false;
    } finally {
        await client.close().catch(() => {});
    }
}

if (!await preflightDatabase(mongo, dbName)) {
    // Exit rather than hand a URI that is known not to work to the framework, which would spend
    // another 30 seconds arriving at the same conclusion less usefully.
    process.exit(1);
}

const app = new MeshApp({ nodeID: flag('id', os.hostname()) });

app.use(new RegistryModule());
app.use(new DatabaseModule({ uri: mongo, dbName }));
app.use(new NetworkModule({
    port: wsPort,
    transports: [new WSTransport(new JSONSerializer(), wsPort, wsHost)],
    bootstrapNodes: bootstrap,
}));
app.use(new BrokerModule());

await app.start();

// After start, always: registerModule queues into pendingModules before it and that flush is
// unawaited, so a module registered earlier may never be mounted.

/**
 * **The fleet is always on, and the rest are switches.**
 *
 * This node registered every service directly, so the Supervisor owned nothing and
 * `supervisor.service_status` was not mounted anywhere. `node.assign` then failed with *"Local tool
 * not found: supervisor.service_status — no domain 'supervisor' is mounted"*, which is the fleet
 * correctly reporting that it has no mechanism to switch anything. Assignment was a control surface
 * over nothing.
 *
 * `fleet` stays direct because it is the thing that answers *what should I be running* — a node
 * that had to be told to run the service that receives its assignment could never receive one.
 * Same reason `identity` and `api` stay direct: without them nobody can authenticate to give the
 * order, and a node that can be switched off from the outside and not back on is a node somebody
 * drives to a datacentre for.
 *
 * Everything else goes into the Supervisor's manifest and can be started and stopped live.
 */
await app.registerModule(new FleetService());

const supervisor = new Supervisor(app, { services: [] }, repoRoot);
await app.registerModule(new SupervisorService(supervisor));

/**
 * The switchable set, built in code rather than read from a manifest file.
 *
 * A file would be a second place to keep the same list, and it would go stale the first time a
 * service moved — the paths are `dist/*` in this repository and this repository already knows them.
 * `node.provision` writes *new* entries at run time through `registerEntry`; these are the ones
 * that ship with the node.
 *
 * None of these takes a constructor argument it cannot default: the Supervisor does `new
 * ServiceClass()`, and `blobRoot`, the CDN port and the CDN URL all fall back to the environment.
 * They are exported here so a Supervisor-constructed instance lands on the same values this
 * process was started with.
 */
process.env.MESH_BLOB_ROOT = blobRoot;
process.env.CDN_PORT = String(cdnPort);
process.env.CDN_URL = cdnUrl;

for (const [name, path] of [
    ['catalog', './dist/catalog/catalog.service.js'],
    ['builder', './dist/builder/builder.service.js'],
    ['cdn', './dist/cdn/cdn.service.js'],
    /**
     * Switchable like the rest, and that is the decision rather than an oversight.
     *
     * Telemetry is the one service whose absence must not break anything: a node that cannot record
     * what happened still has to serve. Making it switchable says so — a deployment that does not
     * want it assigns it nowhere and every other service carries on, because nothing calls into it
     * synchronously. The cdn and api write through a sink that falls back to a process-local
     * default when the service is not there.
     */
    ['telem', './dist/telem/telem.service.js'],
]) {
    supervisor.registerEntry({ name, path, dependsOn: [] });
}

/**
 * What this node runs, asked rather than assumed.
 *
 * `node.hello` answers with the desired set, which is the whole point of the fleet: a node is dumb
 * and loads what it is told to load. **A node with no assignment yet starts everything**, because
 * the alternative is that adding the fleet silently turned every existing deployment off.
 */
const assignment = await app.call('node.hello', { hostname: app.nodeID }).catch(() => null);
const desired = assignment?.services ?? [];

const switchable = (desired.length > 0 ? desired : ['catalog', 'builder', 'cdn'])
    .filter((name) => !CORE_SERVICES.includes(name));

for (const name of switchable) {
    await supervisor.serviceStart(name).catch((error) => {
        process.stderr.write(`[node] could not start ${name}: ${String(error?.message ?? error)}\n`);
    });
}
/**
 * The `authorize` hook, without which **every scoped collection is unreachable over HTTP**.
 *
 * `api.service.ts` says it plainly: *"The usual cause is a site with no `authorize` hook. The coarse
 * gate cannot resolve a scope — only the site knows what an organization means to it."* The gate
 * resolves a caller's identity and stops there; the hook turns that caller into the **scope** the
 * request runs in, which becomes `meta.user.tenant_id` and confines every `scopedBy` collection.
 *
 * With no hook the resolved scope is always empty, so D3's `scopedBy` refuses every read and write —
 * `site.find` answered 401 for a correctly signed-in caller while `part.find` and `release.find`
 * answered 200, because those two are not scoped. Found by the first console to get past sign-in,
 * which is the third time that sentence has been written about this repository.
 *
 * **A caller-supplied organization is a request, never a grant.** The header names one; this hook
 * checks the caller is actually a member before honouring it, and refuses rather than falling back
 * to a different organization — silently acting in the wrong scope is the failure that matters.
 */
const authorize = async ({ caller, requestedScope }) => {
    if (caller === undefined) return { authorized: true };

    const me = await app.call('identity.whoami', {}, { meta: { user: { id: caller.userId } } });
    const memberships = me?.organizations ?? [];

    if (requestedScope !== undefined) {
        const member = memberships.some((m) => m.organizationId === requestedScope);
        return member
            ? { authorized: true, resolvedScope: requestedScope }
            : { authorized: false, status: 404, code: 'no_such_organization',
                // 404, not 403: whether an organization exists is not something an unrelated caller
                // gets to confirm by probing. Same reasoning as `build_start`'s publisher check.
                message: 'No such organization.' };
    }

    // Exactly one membership is the ordinary case and needs no header. More than one is ambiguous,
    // and guessing which is how a request reads the wrong organization's data.
    if (memberships.length === 1) return { authorized: true, resolvedScope: memberships[0].organizationId };
    return { authorized: true };
};

const api = new ApiService({ port: apiPort, authorize });
await app.registerModule(api);
const database = app.getProvider('database');
await app.registerModule(createIdentityModule({ store: mongoStore(database) }));

/**
 * **The agent surface, off unless a port is given.**
 *
 * `--mcp 5006` starts it; no flag starts nothing. Off by default because an MCP endpoint is a way
 * for something that is not a person to drive a site, and a node should not acquire one because it
 * was upgraded.
 *
 * It is handed the api's own `descriptorForHost` and `ticketCache` rather than resolving a site or
 * validating a ticket itself. That is the whole design: one exposure, two projections. If the MCP
 * computed its own view of what a site exposes, `visibility` would mean one thing over HTTP and
 * another to an agent, and the second copy is the one that goes wrong.
 */
const mcpPort = flag('mcp', process.env.MESH_MCP_PORT ?? '');
if (mcpPort !== '') {
    const { McpService } = await import('../dist/api/mcp.service.js');
    await app.registerModule(new McpService(
        (host) => api.descriptorForHost(host),
        (key) => globalContractRegistry.get(key),
        {
            port: Number(mcpPort),
            ...(api.ticketCache === undefined ? {} : { tickets: api.ticketCache }),
            ...(authorize === undefined ? {} : { authorize }),
        },
    ));
}

/**
 * **The password is not printed, and it was.**
 *
 * This banner wrote `mongo` verbatim. Against `mongodb://localhost:27017` that is harmless and it
 * is what every local run shows, so it survived. The first time this node was pointed at Atlas it
 * printed a live `mongodb+srv://user:password@…` into the systemd journal — on every boot, readable
 * by anything that can read journals, and shipped wherever logs get shipped.
 *
 * A banner exists to say *where am I pointed*, which the host and database name answer completely.
 * The credential was never part of the question.
 */
const safeMongo = safeUri(mongo);

process.stdout.write(
    `\nmesh-serve is up\n` +
    // The host it actually binds, not a hardcoded loopback: on the head this is 0.0.0.0 and
    // printing 127.0.0.1 made a node reachable from the internet look like one that was not.
    `  mesh      ws://${wsHost}:${String(wsPort)}\n` +
    `  cdn       ${cdnUrl}\n` +
    `  api       http://127.0.0.1:${String(apiPort)}\n` +
    `  mcp       ${mcpPort === '' ? '(off — pass --mcp <port>)' : `http://127.0.0.1:${String(mcpPort)}/mcp`}\n` +
    `  mongo     ${safeMongo}/${dbName}\n` +
    `  artifacts ${blobRoot}\n` +
    `  config    ${envFile ?? "(no .env found — using the environment only)"}\n\n` +
    `Ctrl-C to stop.\n`,
);

const stop = async () => {
    // Explicitly, so open subscriptions are told rather than dropped: a browser cannot tell a
    // process that exited from a network blip, and reconnects either way.
    process.stdout.write('\nstopping…\n');
    await app.stop();
    process.exit(0);
};

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
