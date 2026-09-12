#!/usr/bin/env node
/**
 * A mesh-serve node.
 *
 * One process: identity, the site record, and the HTTP projection. Not a deployment story — that is
 * the fleet's job and it is unbuilt — but the thing that has to exist before any of it can be
 * exercised by something that is not a test.
 *
 * ```
 * node bin/node.mjs --ws 4001 --api 5005 --db mesh-serve-dev
 * ```
 *
 * Configuration comes from a `.env` beside the checkout, or `/etc/mesh/node.env`. Flags override it
 * for ports and paths; secrets are only ever in the file.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ApiService, IdentityService, ServeService, bootstrap, collectionServices,
} from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const apiPort = Number(flag('api', '5005'));
const apiHost = flag('api-host', '127.0.0.1');
const controlHost = flag('control-host', '127.0.0.1');

const mongo = flag('mongo', process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
const dbName = flag('db', 'mesh-serve');
const peers = (flag('bootstrap', process.env.MESH_BOOTSTRAP ?? '') || '')
    .split(',').map((n) => n.trim()).filter((n) => n !== '');

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
    bootstrapNodes: peers,
}));
app.use(new BrokerModule());

await app.start();

/**
 * The three services, registered directly.
 *
 * **No supervisor, and that is honest rather than a simplification.** A supervisor is a mechanism
 * for switching services a node was assigned; nothing here is assigned yet, so a supervisor would be
 * a control surface over nothing — which is exactly what the last one was, and `spec/fleet.md` §1 is
 * the record of finding that out.
 *
 * Order matters once: identity's first boot creates the account that `bootstrap` then needs.
 */
// The collections first: each is its own module so that mesh dispatches its CRUD hooks to it, and
// a service below that calls `user.find` needs the collection already mounted to answer.
for (const collection of collectionServices()) {
    await app.registerModule(collection);
}

await app.registerModule(new IdentityService());
await app.registerModule(new ServeService());
await app.registerModule(new ApiService({ port: apiPort, host: apiHost }));

/**
 * Bring the cluster up.
 *
 * A cluster with no sites cannot be reached, so this runs after every module is registered and
 * creates what is missing: the first organization, the operator's membership in it, and the control
 * site on `127.0.0.1`. Idempotent — a restart creates nothing and says so by printing nothing.
 */
const brought = await bootstrap(app, {
    host: controlHost,
    announce: (line) => process.stdout.write(`${line}\n`),
});

/**
 * **The password is not printed, and it was.**
 *
 * This banner wrote `mongo` verbatim. Against `mongodb://localhost:27017` that is harmless and it is
 * what every local run shows, so it survived. The first time this node was pointed at Atlas it
 * printed a live `mongodb+srv://user:password@…` into the systemd journal — on every boot, readable
 * by anything that can read journals, and shipped wherever logs get shipped.
 *
 * A banner exists to say *where am I pointed*, which the host and database name answer completely.
 * The credential was never part of the question.
 */
process.stdout.write(
    `\nmesh-serve is up\n` +
    // The host it actually binds, not a hardcoded loopback: printing 127.0.0.1 for a node bound to
    // 0.0.0.0 made one reachable from the internet look like one that was not.
    `  mesh      ws://${wsHost}:${String(wsPort)}\n` +
    `  api       http://${apiHost}:${String(apiPort)}\n` +
    `  control   ${brought.host} — ${String(brought.created.length)} thing(s) created this boot\n` +
    `  mongo     ${safeUri(mongo)}/${dbName}\n` +
    `  config    ${envFile ?? '(no .env found — using the environment only)'}\n\n` +
    `  npx mesh-serve login\n\n` +
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
