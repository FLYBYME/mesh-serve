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

/**
 * Where the control site sends its own requests.
 *
 * The cdn creates that site (`cdn/methods/control.ts`) and knows its own origin but not the api's —
 * they are deliberately separate ports — and `site.api` must be a real origin rather than empty. The
 * node chose both numbers, so the node is what says so.
 *
 * **Set here, beside the flag, and not where `ApiService` is constructed.** That is two hundred
 * lines further down and *after* the Supervisor starts the switchable services, so the cdn had
 * already read an unset variable by the time it was assigned. The value was right and it arrived
 * late, which reads in the log as a validation error about an empty string.
 */
process.env.MESH_CONTROL_API ??= `http://127.0.0.1:${String(apiPort)}`;

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

try {
await app.start();

await app.registerModule(new FleetService());

const supervisor = new Supervisor(app, { services: [] }, repoRoot);
await app.registerModule(new SupervisorService(supervisor));

process.env.MESH_BLOB_ROOT = blobRoot;
process.env.CDN_PORT = String(cdnPort);
process.env.CDN_URL = cdnUrl;

for (const [name, path] of [
    ['catalog', './dist/catalog/catalog.service.js'],
    ['builder', './dist/builder/builder.service.js'],
    ['cdn', './dist/cdn/cdn.service.js'],
    ['telem', './dist/telem/telem.service.js'],
]) {
    supervisor.registerEntry({ name, path, dependsOn: [] });
}

const assignment = await app.call('node.hello', { hostname: app.nodeID }).catch(() => null);
const desired = assignment?.services ?? [];

const switchable = (desired.length > 0 ? desired : ['catalog', 'builder', 'cdn'])
    .filter((name) => !CORE_SERVICES.includes(name));

for (const name of switchable) {
    await supervisor.serviceStart(name).catch((error) => {
        process.stderr.write(`[node] could not start ${name}: ${String(error?.message ?? error)}\n`);
    });
}

const { membershipAuthorize } = await import('../dist/api/methods/authorize.js');
const authorize = membershipAuthorize((tool, params, options) => app.call(tool, params, options));

const api = new ApiService({ port: apiPort, authorize });
await app.registerModule(api);
const database = app.getProvider('database');
await app.registerModule(createIdentityModule({ store: mongoStore(database) }));

const { ApprovalService } = await import('../dist/approval/index.js');
await app.registerModule(new ApprovalService());

const servicePaths = [];
for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === '--service') servicePaths.push(process.argv[i + 1]);
}

for (const servicePath of servicePaths) {
    const resolved = path.resolve(process.cwd(), servicePath);
    const module = await import(resolved);
    const Service = module.default ?? module.Service;

    if (typeof Service !== 'function') {
        process.stderr.write(
            `--service ${servicePath}: no default export to construct.\n`
            + `  A service module default-exports its class, the way the supervisor expects to find it.\n`,
        );
        process.exit(2);
    }

    await app.registerModule(new Service());
    process.stdout.write(`  service   ${servicePath} (development — provision it for real)\n`);
}

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
} catch (error) {
    if (error && error.code === 85) {
        const match = /Index already exists with a different name: (.*)/.exec(error.message);
        const indexName = match ? match[1] : 'unknown_index';
        
        let collectionName = 'unknown_collection';
        try {
            const { MongoClient } = await import('mongodb');
            const client = new MongoClient(mongo, { serverSelectionTimeoutMS: 5000 });
            await client.connect();
            const cols = await client.db(dbName).collections();
            for (const col of cols) {
                const indexes = await col.indexes().catch(() => []);
                if (indexes.some(idx => idx.name === indexName)) {
                    collectionName = col.collectionName;
                    break;
                }
            }
            await client.close();
        } catch (e) {
            // ignore
        }

        process.stderr.write(
            `\nStartup failed: A legacy index exists that conflicts with the current schema.\n` +
            `  Database:   ${dbName}\n` +
            `  Collection: ${collectionName}\n` +
            `  Index:      ${indexName}\n\n` +
            `This is caused by an older version of mesh-serve that created an index with mongo's default name.\n` +
            `To fix this, you must drop the old index so mesh-serve can create the named one.\n` +
            `Run this in your mongo shell:\n` +
            `  use ${dbName}\n` +
            `  db.${collectionName}.dropIndex("${indexName}")\n\n`
        );
        process.exit(1);
    }
    throw error;
}

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
