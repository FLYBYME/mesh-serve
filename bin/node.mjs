#!/usr/bin/env node
/**
 * A mesh-serve node.
 *
 * One process running all five services, reachable over the mesh and over HTTP. Not a deployment
 * story — that is the fleet's job, and it is unbuilt — but the thing that has been missing while
 * every service in this repository could only be exercised by a test that constructed it.
 *
 * ```
 * MONGODB_URI=mongodb://localhost:27017 node bin/node.mjs --ws 4001 --cdn 8080 --api 5005
 * ```
 *
 * Everything is a flag with a default, because a node that needs a configuration file before it can
 * start is a node nobody runs by hand — and until the fleet exists, by hand is the only way.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import os from 'node:os';
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

await app.registerModule(new ApiService({ port: apiPort, authorize }));
const database = app.getProvider('database');
await app.registerModule(createIdentityModule({ store: mongoStore(database) }));

process.stdout.write(
    `\nmesh-serve is up\n` +
    `  mesh      ws://127.0.0.1:${String(wsPort)}\n` +
    `  cdn       ${cdnUrl}\n` +
    `  api       http://127.0.0.1:${String(apiPort)}\n` +
    `  mongo     ${mongo}/${dbName}\n` +
    `  artifacts ${blobRoot}\n\n` +
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
