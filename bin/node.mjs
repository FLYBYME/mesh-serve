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

import { ApiService } from '../dist/api/api.service.js';
import { BuilderService } from '../dist/builder/builder.service.js';
import { CatalogService } from '../dist/catalog/catalog.service.js';
import { CdnService } from '../dist/cdn/cdn.service.js';
import { createIdentityModule, mongoStore } from '../dist/identity/index.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
};

const wsPort = Number(flag('ws', '4001'));
const cdnPort = Number(flag('cdn', '8080'));
const cdnUrl = flag('cdn-url', process.env.CDN_URL ?? `http://127.0.0.1:${String(cdnPort)}`);
const apiPort = Number(flag('api', '5005'));
const mongo = flag('mongo', process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
const dbName = flag('db', 'mesh-serve');
const blobRoot = flag('artifacts', process.env.MESH_BLOB_ROOT ?? './.artifacts');
const bootstrap = (flag('bootstrap', process.env.MESH_BOOTSTRAP ?? '') || '')
    .split(',').map((n) => n.trim()).filter((n) => n !== '');

const app = new MeshApp({ nodeID: flag('id', `serve-${Math.random().toString(36).slice(2, 7)}`) });

app.use(new RegistryModule());
app.use(new DatabaseModule({ uri: mongo, dbName }));
app.use(new NetworkModule({
    port: wsPort,
    transports: [new WSTransport(new JSONSerializer(), wsPort)],
    bootstrapNodes: bootstrap,
}));
app.use(new BrokerModule());

await app.start();

// After start, always: registerModule queues into pendingModules before it and that flush is
// unawaited, so a module registered earlier may never be mounted.
await app.registerModule(new CatalogService());
await app.registerModule(new BuilderService({ blobRoot }));
await app.registerModule(new CdnService({ port: cdnPort, url: cdnUrl, blobRoot }));
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
