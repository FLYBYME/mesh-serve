#!/usr/bin/env -S npx tsx
/**
 * Stands up console.localhost end to end, by hand, over the real primitives -- there is no `seed`
 * convenience command any more (deleted before this session; see HANDOVER.md, now historical).
 *
 * repo -> part -> artifact.requestBuild -> composition -> composition.compose -> cdn.create ->
 * cdn.deploy -> expose.add, all called directly through the broker (system-level, the same way
 * identity.service.ts's own bootstrap does it -- no ticket needed, only meta.tenant_id for scoping).
 *
 * mesh-web and mesh-core are built from the local bare mirrors
 * (/home/ubuntu/code/.git-remotes/{mesh-web,mesh-core}.git), not GitHub -- mesh-web's mirror has
 * diverged history from other work (dispatch/14, dispatch/16, dispatch/17 branches untouched), so
 * this pushes the local repo's HEAD to a dedicated `console-demo` branch rather than touching
 * `master`.
 */
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import type { IServiceBroker } from '@flybyme/mesh';

import { resolveHandler } from '../catalog/methods/resolveHandler.js';
import '../identity/contracts/user.contract.js';
import '../identity/contracts/organization.contract.js';
import '../identity/contracts/membership.contract.js';
import '../identity/contracts/role.contract.js';
import '../identity/contracts/ticket.contract.js';
import '../identity/contracts/apiToken.contract.js';
import '../identity/contracts/identity.contract.js';
import '../cdn/contracts/site.contract.js';
import { CATALOG_DOMAINS } from '../catalog/domains.js';
import '../catalog/contracts/repo.contract.js';
import '../catalog/contracts/part.contract.js';
import '../catalog/contracts/composition.contract.js';
import '../catalog/contracts/artifact.contract.js';
import '../catalog/contracts/release.contract.js';
import '../catalog/contracts/corePart.contract.js';
import '../api/contracts/api.contract.js';
import '../api/contracts/expose.contract.js';
import '../api/contracts/want.contract.js';
import '../api/contracts/generateClient.contract.js';

const DB_NAME = 'mesh-console-demo';
const WS_PORT = 17654;
const API_PORT = 17655;
const CDN_PORT = 17656;

const MESH_WEB_URL = '/home/ubuntu/code/.git-remotes/mesh-web.git';
const MESH_WEB_REF = 'console-demo';
const MESH_CORE_URL = '/home/ubuntu/code/.git-remotes/mesh-core.git';
const MESH_CORE_REF = 'master';

/**
 * `role: 'operator'` on organization/membership/role -- found live, reported by a real person
 * poking at the deployed page: `identity.organization.find` and `identity.role.find` have no
 * `scopedBy` at all (an organization can't be scoped to itself; a role isn't tenant data), and
 * `identity.organization.create`/`identity.membership.create` reach real mutation with no auth
 * check of their own -- exposing any of these with no role, as this list originally did, let an
 * anonymous caller list every organization and role on the cluster and create new ones. Matches
 * what mesh-operator's own mesh.json already documented as the correct gate for exactly this
 * reason, before this session ever wrote this list.
 */
const IDENTITY_CONTRACTS: readonly { contract: string; role?: string }[] = [
    { contract: 'identity.ticket.issue' },
    { contract: 'identity.ticket.signOut' },
    { contract: 'identity.whoami' },
    { contract: 'identity.user.setPassword' },
    { contract: 'identity.organization.find', role: 'operator' },
    { contract: 'identity.organization.create', role: 'operator' },
    { contract: 'identity.membership.find', role: 'operator' },
    { contract: 'identity.membership.create', role: 'operator' },
    { contract: 'identity.membership.delete', role: 'operator' },
    { contract: 'identity.role.find', role: 'operator' },
];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForBuild(app: MeshApp, meta: { tenant_id: string }, partId: string, label: string): Promise<void> {
    for (let i = 0; i < 90; i++) {
        const artifacts = await app.call('serve.artifact.find', { query: { partId } }, { meta });
        const latest = artifacts[artifacts.length - 1];
        if (latest?.status === 'success') {
            console.log(`  ${label}: built (${latest.hash})`);
            return;
        }
        if (latest?.status === 'failed') {
            throw new Error(`${label} failed: ${latest.error ?? 'unknown error'}`);
        }
        await sleep(2000);
    }
    throw new Error(`${label} timed out waiting for a build`);
}

async function main(): Promise<void> {
    process.env.API_PORT = String(API_PORT);
    process.env.SERVER_PORT = String(CDN_PORT);

    const logger = new Logger(LogLevel.INFO, {}, (_level, _formatted, originalMsg) => {
        if (typeof originalMsg === 'string') console.log(originalMsg);
    });

    // Per process, like composeOnCluster.ts already is -- see cli/commands/bootstrap.ts's note.
    const app = new MeshApp({ nodeID: `console-demo-${String(process.pid)}`, logger });
    app.use(new RegistryModule());
    app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), WS_PORT)] }));
    app.use(new DatabaseModule({ dbName: DB_NAME }));
    app.use(new BrokerModule());


    await app.start();

    // After start, not before: serve.cdn's register binds its listener through
    // serve.cdn.listen, which is a real call and wants a running broker underneath it.
    const broker = app.getProvider<IServiceBroker>('broker');
    for (const domain of CATALOG_DOMAINS) await broker.loadDomain(domain, {}, { resolve: resolveHandler });
    await broker.loadDomain('identity', {}, { resolve: resolveHandler });
    await broker.call('identity.role.ensureBuiltins', {});
    await broker.loadDomain('serve.cdn', {}, { resolve: resolveHandler });
    await broker.loadDomain('serve.api', {}, { resolve: resolveHandler });
    await broker.loadDomain('serve.expose', {}, { resolve: resolveHandler });

    const org = await app.call('identity.organization.find_one', { query: { slug: 'platform' } });
    if (org === undefined) throw new Error('No "platform" organization -- first boot did not run?');
    const meta = { tenant_id: org.id };

    console.log('\n== repos ==');
    const meshWebRepo = await app.call('serve.repo.create', { tenantId: org.id, name: 'mesh-web', url: MESH_WEB_URL, defaultBranch: MESH_WEB_REF }, { meta });
    const meshCoreRepo = await app.call('serve.repo.create', { tenantId: org.id, name: 'mesh-core', url: MESH_CORE_URL, defaultBranch: MESH_CORE_REF }, { meta });

    console.log('== parts ==');
    const kernelPart = await app.call('serve.part.create', {
        tenantId: org.id, repoId: meshWebRepo.id, key: 'platform/kernel', kind: 'kernel', path: '.', entryPoint: 'src/index.ts', imports: '@flybyme/mesh-web', wants: [],
    }, { meta });
    const uiPart = await app.call('serve.part.create', {
        tenantId: org.id, repoId: meshCoreRepo.id, key: 'platform/ui', kind: 'extension', path: '.', entryPoint: 'src/ui/index.ts', imports: '@flybyme/mesh-core/ui', wants: [],
    }, { meta });
    const authPart = await app.call('serve.part.create', {
        tenantId: org.id, repoId: meshCoreRepo.id, key: 'platform/auth', kind: 'extension', path: '.', entryPoint: 'src/auth/index.ts', imports: '@flybyme/mesh-core/auth', wants: [],
    }, { meta });
    const identityPart = await app.call('serve.part.create', {
        tenantId: org.id, repoId: meshCoreRepo.id, key: 'platform/identity', kind: 'application', path: '.', entryPoint: 'src/identity/index.ts', wants: [],
    }, { meta });
    const chromePart = await app.call('serve.part.create', {
        tenantId: org.id, repoId: meshCoreRepo.id, key: 'platform/chrome', kind: 'extension', path: '.', entryPoint: 'src/chrome/index.ts', wants: [],
    }, { meta });

    console.log('== requesting builds ==');
    const kernelArtifact = await app.call('serve.artifact.requestBuild', { partId: kernelPart.id, ref: MESH_WEB_REF }, { meta });
    const uiArtifact = await app.call('serve.artifact.requestBuild', { partId: uiPart.id, ref: MESH_CORE_REF }, { meta });
    const authArtifact = await app.call('serve.artifact.requestBuild', { partId: authPart.id, ref: MESH_CORE_REF }, { meta });
    const identityArtifact = await app.call('serve.artifact.requestBuild', { partId: identityPart.id, ref: MESH_CORE_REF }, { meta });
    const chromeArtifact = await app.call('serve.artifact.requestBuild', { partId: chromePart.id, ref: MESH_CORE_REF }, { meta });

    console.log('== waiting for builds (catalog polls every 60s) ==');
    await Promise.all([
        waitForBuild(app, meta, kernelPart.id, 'kernel'),
        waitForBuild(app, meta, uiPart.id, 'ui'),
        waitForBuild(app, meta, authPart.id, 'auth'),
        waitForBuild(app, meta, identityPart.id, 'identity'),
        waitForBuild(app, meta, chromePart.id, 'chrome'),
    ]);
    void kernelArtifact; void uiArtifact; void authArtifact; void identityArtifact; void chromeArtifact;

    console.log('== composition ==');
    const composition = await app.call('serve.composition.create', {
        tenantId: org.id, key: 'console', kernelPartKey: kernelPart.id, drivers: [],
        extensions: [uiPart.id, authPart.id, chromePart.id],
        applications: [identityPart.id],
        services: [],
    }, { meta });
    const release = await app.call('serve.composition.compose', { id: composition.id }, { meta });
    console.log(`  release ${release.hash}, ${release.artifacts.length} artifacts pinned`);

    console.log('== exposing identity contracts on api.localhost ==');
    const api = await app.call('serve.api.resolveByHost', { apiHost: 'api.localhost' });
    if (api === undefined) throw new Error('No api.localhost -- first boot did not run?');
    for (const { contract, role } of IDENTITY_CONTRACTS) {
        const existing = await app.call('serve.expose.find_one', { query: { apiId: api.id, contract } }, { meta });
        if (existing === undefined) {
            await app.call('serve.expose.add', { apiId: api.id, contract, ...(role !== undefined ? { role } : {}) }, { meta });
            console.log(`  exposed ${contract}${role !== undefined ? ` (role: ${role})` : ''}`);
        }
    }

    console.log('== cdn site ==');
    const site = await app.call('serve.cdn.create', {
        tenantId: org.id,
        host: 'console.localhost',
        apiId: api.id,
        mcpHost: 'console-mcp.localhost',
        application: 'console',
        policy: {},
        open: [{ application: identityPart.key }],
        theme: {},
        title: 'Console',
        description: 'The identity console, composed live for real.',
        indexable: false,
    }, { meta });

    const deployed = await app.call('serve.cdn.deploy', { siteId: site.id, releaseId: release.id }, { meta });
    console.log(`  deployed: ${deployed.site.host} -> ${deployed.site.releaseHash}`);

    console.log(`\nconsole.localhost is live: http://127.0.0.1:${CDN_PORT}  (Host: console.localhost)`);
    console.log(`api.localhost:              http://127.0.0.1:${API_PORT}  (Host: api.localhost)`);
    console.log('Leave this running; Ctrl-C to stop.');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
