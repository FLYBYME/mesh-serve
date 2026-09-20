import {
    BrokerModule,
    JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule,
    RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IServiceBroker, IMeshApp, IServiceRegistry, z } from '@flybyme/mesh';
import type { RegisterInput, User } from './identity/contracts/user.contract.js';
import type { roleCrud } from './identity/contracts/role.contract.js';
import { siteCrud } from './cdn/contracts/site.contract.js';
import { apiCrud, type Api } from './api/contracts/api.contract.js';
import type { Organization } from './identity/contracts/organization.contract.js';
import type { Part } from './catalog/contracts/part.contract.js';
import type { Artifact } from './catalog/contracts/artifact.contract.js';
import { loadSite, DEFAULT_SITE_PATH } from './console.site.js';

const site = loadSite(DEFAULT_SITE_PATH);

type RoleType = z.infer<typeof roleCrud.baseSchema>;

const User: RegisterInput = {
    email: 'admin@example.com',
    password: 'password1234567',
    displayName: 'Platform Admin',
}

const Roles: RoleType[] = [
    {
        key: 'operator',
        name: 'Operator',
        scope: 'global',
        builtin: true,
        inherits: [],
        permissions: ['**'],
    },
    {
        key: 'owner',
        name: 'Owner',
        scope: 'organization',
        builtin: true,
        inherits: [],
        permissions: [],
    },
    {
        key: 'admin',
        name: 'Admin',
        scope: 'organization',
        builtin: true,
        inherits: [],
        permissions: [],
    },
    {
        key: 'member',
        name: 'Member',
        scope: 'organization',
        builtin: true,
        inherits: [],
        permissions: [],
    },
];


async function setup(): Promise<{ broker: IServiceBroker; registry: IServiceRegistry; mesh: IMeshApp }> {
    const logger = new Logger(LogLevel.WARN);
    const serializer = new JSONSerializer();

    const node = new MeshApp({ nodeID: 'repl-provider-1', logger });

    node.use(new RegistryModule());
    node.use(new NetworkModule({
        bootstrapNodes: ['ws://127.0.0.1:6005'],
        transports: [new WSTransport(serializer, 0)],
    }));
    node.use(new BrokerModule());

    await node.start();

    const broker = node.getProvider<IServiceBroker>('broker');
    const registry = node.getProvider<IServiceRegistry>('registry');

    await registry.waitForNodes(2);

    return { broker, registry, mesh: node };
}

async function init(broker: IServiceBroker, slug: string, name: string, ownerId: string) {

    const roles = [];

    for (const role of Roles) {
        try {
            const foundRole = await broker.call('identity.role.find_one', {
                query: { key: role.key, scope: role.scope }
            })
            if (foundRole) {
                roles.push(foundRole);
                continue;
            }

            const createdRole = await broker.call('identity.role.create', role);
            roles.push(createdRole);
            console.log('Created role', createdRole);
        } catch (error) {
            console.error(error);
        }
    }

    const foundUser = await broker.call('identity.user.find_one', { query: { email: User.email } });

    if (foundUser) {
        console.log(`User already exists ${foundUser.id}`);

        const org = await broker.call('identity.organization.find_one', {
            query: { slug: slug }
        })

        if (!org) {
            throw new Error('Org not found');
        }
        return { org, user: foundUser }

    }
    const register = await broker.call('identity.user.register', User);

    let user = await broker.call('identity.user.resolve', { id: register.userId });

    if (!user) {
        throw new Error('No user found');
    }

    user = await broker.call('identity.user.update', {
        id: user.id,
        provisional: false,
        roles: [
            ...roles.filter((role) => role.key == 'operator').map((role) => role.key)
        ]
    });



    const org = await broker.call('identity.organization.create', {
        slug: 'platform',
        name: 'Platform',
        ownerId: user.id,
    }, { meta: { tenant_id: user.id } });

    const member = await broker.call('identity.membership.create', {
        userId: user.id,
        organizationId: org.id,
        roleKey: 'owner',
        joinedAt: new Date(),
    }, {
        meta: {
            organization_id: org.id,
            user_id: user.id
        }
    });


    return { org, user };
}

async function setupConsole(broker: IServiceBroker, org: Organization, user: User) {

    const meta = {
        tenant_id: org.id,
        user_id: user.id
    }

    const foundConsoleApi = await broker.call('serve.api.find_one', {
        query: {
            apiHost: site.api
        }
    }, { meta });

    if (foundConsoleApi) {
        console.log(`Console api already exists ${foundConsoleApi.id}`);
        throw new Error('Console api already exists');
    }
    const consoleApi = await broker.call('serve.api.create', {
        tenantId: org.id,
        apiHost: site.api,
        description: 'Console api',
    }, { meta });
    console.log('Console api created', consoleApi);

    return consoleApi;
}

async function setupSite(broker: IServiceBroker, org: Organization, user: User, consoleApi: Api) {

    const meta = {
        tenant_id: org.id,
        user_id: user.id
    };

    const repos = [];

    for (const repo of site.repos) {
        let foundRepo = await broker.call('serve.repo.find_one', {
            query: { tenantId: org.id, url: repo.url }
        }, { meta });

        if (!foundRepo) {
            foundRepo = await broker.call('serve.repo.create', {
                tenantId: org.id,
                name: repo.name,
                url: repo.url,
                defaultBranch: repo.ref,
            }, { meta });
            console.log('Created repo', foundRepo.id);
        } else {
            foundRepo = await broker.call('serve.repo.update', {
                id: foundRepo.id,
                name: repo.name,
                defaultBranch: repo.ref,
            }, { meta });
            console.log('Repo already exists, reconciled', foundRepo.id);
        }
        repos.push(foundRepo);
    }

    const parts: Part[] = [];

    for (const part of site.parts) {
        const repo = repos.find((repo) => repo.name === part.repoName);
        if (!repo) {
            console.log(part)
            throw new Error('repo not found');
        }
        const foundPart = await broker.call('serve.part.find_one', {
            query: { tenantId: org.id, key: part.key }
        }, { meta });
        if (!foundPart) {
            const createdPart = await broker.call('serve.part.create', {
                tenantId: org.id,
                repoId: repo.id,
                key: part.key,
                kind: part.kind,
                path: part.path,
                entryPoint: part.entryPoint,
                ...(part.imports !== undefined ? { imports: part.imports } : {}),
                wants: part.wants,
                description: part.description,
            }, { meta });
            console.log('Created part', createdPart.id);
            parts.push(createdPart);
        } else {
            const updatedPart = await broker.call('serve.part.update', {
                id: foundPart.id,
                repoId: repo.id,
                kind: part.kind,
                path: part.path,
                entryPoint: part.entryPoint,
                ...(part.imports !== undefined ? { imports: part.imports } : {}),
                wants: part.wants,
                description: part.description,
            }, { meta });
            console.log('Part already exists, reconciled', updatedPart.id);
            parts.push(updatedPart);
        }
    }



    const kernelPart = parts.find((part) => part.kind === 'kernel');
    if (!kernelPart) {
        throw new Error('No kernel part found');
    }

    const themePart = parts.find((part) => part.kind === 'theme');
    if (!themePart) {
        console.log(`theme part not found`)
    }

    const drivers = parts.filter((part) => part.kind === 'driver');
    const extensions = parts.filter((part) => part.kind === 'extension');
    const applications = parts.filter((part) => part.kind === 'application');

    const servies = parts.filter((part) => part.kind === 'service');

    const composition = await broker.call('serve.composition.create', {
        tenantId: org.id,
        key: 'console',
        kernelPartKey: kernelPart.id,
        theme: themePart?.id,
        drivers: drivers.map((part) => part.id),
        extensions: extensions.map((part) => part.id),
        applications: applications.map((part) => part.id),
        services: servies.map((part) => part.id),
    }, { meta });

    const builds = [];

    for (const part of parts) {
        const repo = repos.find((repo) => repo.id === part.repoId);
        if (!repo) {
            console.log(part)
            throw new Error('repo not found');
        }
        // request build
        const build = await broker.call('serve.artifact.create', {
            tenantId: part.tenantId,
            partId: part.id,
            ref: repo.defaultBranch
        }, { meta });
        console.log('Build created', build);
        builds.push(build);
    }

    const artifacts: Artifact[] = [];

    for (const build of builds) {
        // Explicit timeout -- default RPC timeout is 10s, tighter than a slow first-time
        // clone/npm-install (mesh-demos' theme build) plus any transport hiccup can absorb.
        // Matches serve.queue's own dispatcher, which gives serve.artifact.build 5 minutes.
        const run = await broker.call('serve.artifact.build', { id: build.id }, { meta, timeout: 5 * 60_000 });
        console.log('Build run', run);

        const artifact = await broker.call('serve.artifact.resolve', { id: build.id }, { meta, timeout: 5 * 60_000 });
        if (!artifact || artifact.hash === undefined) {
            throw new Error(`No successful artifact for build ${build.id}`);
        }
        artifacts.push(artifact);
    }

    // hash omitted -- serve.release.create's before-hook mints it from compositionId + parts now.
    const release = await broker.call('serve.release.create', {
        tenantId: org.id,
        compositionId: composition.id,
        artifacts: artifacts,
    }, { meta });
    console.log('Release created', release.hash);



    const cdn = await broker.call('serve.cdn.create', {
        tenantId: org.id,
        host: site.cdn,
        apiId: consoleApi.id,
        application: 'console',
        policy: {}, theme: {},
        open: applications.map((part) => ({ application: part.key })),
        title: 'Console', description: '',
        indexable: false, maintenance: false,
    }, { meta });
    console.log('Site created', cdn.id);

    const deploy = await broker.call('serve.cdn.deploy', { siteId: cdn.id, releaseId: release.id }, { meta });
    console.log('Deploy created', deploy);

    for (const contract of site.exposed) {
        const exposed = await broker.call('serve.expose.add', {
            apiId: consoleApi.id,
            contract: contract
        }, { meta });
        console.log('Exposed action', exposed);
    }

    // The generated, type-safe client for whatever this api now exposes -- what any app (the
    // operator console included) actually imports to call it. Raw broker.call needs no exposure
    // to reach serve.api.generateClient itself; it's the resulting *file* apps depend on.
    const generated = await broker.call('serve.api.generateClient', { apiId: consoleApi.id }, { meta });
    const outPath = path.resolve('../mesh-operator/src/console/generated/api.ts');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, generated.source);
    console.log('Generated client written', outPath, `(${generated.source.length} bytes)`);
}


async function main(): Promise<void> {
    const { broker, mesh } = await setup();

    try {
        const { org, user } = await init(broker, 'platform', 'Platform', '');

        const consoleApi = await setupConsole(broker, org, user);
        await setupSite(broker, org, user, consoleApi);

    } catch (err) {
        console.error(err);
    } finally {
        await mesh.stop();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
