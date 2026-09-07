import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BrokerModule,
    DatabaseModule,
    MeshApp,
    RegistryModule,
    destroyTestApp,
    dropTestDatabase,
    generateTestDbName,
    withTestDatabase,
    type IServiceBroker,
} from '@flybyme/mesh';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeHelloContract } from '../../src/fleet/contracts/node.contract.js';
import { FleetService } from '../../src/fleet/fleet.service.js';
import { loadManifest, Supervisor } from '../../src/supervisor/Supervisor.js';
import { SupervisorService } from '../../src/supervisor/SupervisorService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/supervisor');
const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';
process.env['MONGODB_URI'] = MONGO;
const TEST_DB_NAME = generateTestDbName();

describe('Track E: Fleet layer', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let supervisor: Supervisor;
    const testHostname = 'test-node-host';

    beforeAll(async () => {
        const baseUri = withTestDatabase(MONGO, TEST_DB_NAME);

        app = new MeshApp({
            nodeID: 'fleet-test-node',
            namespace: 'fleet-test',
        });

        const registryModule = new RegistryModule({ preferLocal: true });
        app.use(registryModule);
        app.use(new BrokerModule());
        app.use(new DatabaseModule({ uri: baseUri, dbName: TEST_DB_NAME }));

        await app.start();
        broker = app.getProvider<IServiceBroker>('broker');

        // Set the local node's hostname in the registry to match testHostname
        const localNode = app.registry.getNode('fleet-test-node');
        if (localNode) {
            localNode.hostname = testHostname;
        }

        // Mount supervisor with test fixtures (alpha and beta)
        const { manifest, baseDir } = loadManifest(path.join(FIXTURES_DIR, 'manifest.json'));
        supervisor = new Supervisor(app, manifest, baseDir);
        await app.registerModule(new SupervisorService(supervisor));

        // Mount fleet service
        await app.registerModule(new FleetService());
    });

    /**
     * Every operator call has to carry one now.
     *
     * These tests used to call `node.assign` and `node.status` with no caller at all and were
     * admitted, because the check only ran when `ctx.meta.user` happened to be present. That is the
     * hole `requireOperator` closes: reaching a tool over the mesh is not an identity, and the
     * fleet's control surface was open to anything already on it.
     */
    const asOperator = {
        meta: { user: { id: 'op-user', tenant_id: 'platform', roles: ['operator'] } },
    };

    afterAll(async () => {
        await supervisor.stopAll();
        await destroyTestApp(app);
        await dropTestDatabase(TEST_DB_NAME);
    });

    it('E1: node.hello registers an unassigned node and returns empty desired state', async () => {
        const result = await broker.call('node.hello' as never, {
            hostname: 'new-vps-1',
        } as never) as { hostname: string; services: string[] };

        expect(result.hostname).toBe('new-vps-1');
        expect(result.services).toEqual([]);

        // Idempotent: asking again returns the same desired state
        const second = await broker.call('node.hello' as never, {
            hostname: 'new-vps-1',
        } as never) as { hostname: string; services: string[] };
        expect(second.services).toEqual([]);
    });

    it('E1 / reboot: node identity is hostname, not transient nodeID', async () => {
        // Assign a service to vps-persistent
        await broker.call('node.assign' as never, {
            hostname: 'vps-persistent',
            services: ['alpha'],
        } as never, asOperator);

        // A rebooted node (calling hello anew) retrieves its existing desired state
        const rebooted = await broker.call('node.hello' as never, {
            hostname: 'vps-persistent',
        } as never) as { hostname: string; services: string[] };

        expect(rebooted.hostname).toBe('vps-persistent');
        expect(rebooted.services).toEqual(['alpha']);
    });

    it('node.assign switches services live on a running node', async () => {
        // testHostname is our currently running node ('fleet-test-node')
        expect(supervisor.serviceStatus('alpha')[0]?.status).toBe('stopped');

        // Assign 'alpha' to testHostname
        const assignResult = await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: ['alpha'],
        } as never, asOperator) as {
            hostname: string;
            services: string[];
            applied: boolean;
            started?: string[];
            stopped?: string[];
        };

        expect(assignResult.applied).toBe(true);
        expect(assignResult.started).toEqual(['alpha']);
        expect(supervisor.serviceStatus('alpha')[0]?.status).toBe('running');

        // Now add 'beta' (which depends on 'alpha')
        const assignBoth = await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: ['alpha', 'beta'],
        } as never, asOperator) as {
            applied: boolean;
            started?: string[];
            stopped?: string[];
        };

        expect(assignBoth.applied).toBe(true);
        expect(assignBoth.started).toEqual(['beta']);
        expect(supervisor.serviceStatus('beta')[0]?.status).toBe('running');

        // Now drop 'beta' while keeping 'alpha'
        const dropBeta = await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: ['alpha'],
        } as never, asOperator) as {
            applied: boolean;
            started?: string[];
            stopped?: string[];
        };

        expect(dropBeta.applied).toBe(true);
        expect(dropBeta.stopped).toEqual(['beta']);
        expect(supervisor.serviceStatus('beta')[0]?.status).toBe('stopped');
        expect(supervisor.serviceStatus('alpha')[0]?.status).toBe('running');

        // Now drop 'alpha'
        const dropAll = await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: [],
        } as never, asOperator) as {
            applied: boolean;
            stopped?: string[];
        };

        expect(dropAll.applied).toBe(true);
        expect(dropAll.stopped).toEqual(['alpha']);
        expect(supervisor.serviceStatus('alpha')[0]?.status).toBe('stopped');
    });

    it('node.status answers what this node is running and what it is connected to', async () => {
        // Start alpha on this node
        await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: ['alpha'],
        } as never, asOperator);

        const status = await broker.call('node.status' as never, {
            hostname: testHostname,
        } as never, asOperator) as {
            hostname: string;
            connected: boolean;
            nodeID?: string;
            peers: { nodeID: string }[];
            desiredServices: string[];
            runningServices: string[];
            services?: { name: string; status: string }[];
            nodes?: { hostname: string; connected: boolean }[];
        };

        expect(status.hostname).toBe(testHostname);
        expect(status.connected).toBe(true);
        expect(status.nodeID).toBe('fleet-test-node');
        expect(status.desiredServices).toEqual(['alpha']);
        expect(status.runningServices).toEqual(['alpha']);
        expect(status.services?.find((s) => s.name === 'alpha')?.status).toBe('running');
        expect(Array.isArray(status.peers)).toBe(true);
        expect(Array.isArray(status.nodes)).toBe(true);

        // Status for an offline node answers desired state with connected: false
        const offlineStatus = await broker.call('node.status' as never, {
            hostname: 'vps-persistent',
        } as never, asOperator) as {
            hostname: string;
            connected: boolean;
            desiredServices: string[];
            runningServices: string[];
        };

        expect(offlineStatus.hostname).toBe('vps-persistent');
        expect(offlineStatus.connected).toBe(false);
        expect(offlineStatus.desiredServices).toEqual(['alpha']);
        expect(offlineStatus.runningServices).toEqual([]);

        // Clean up: stop alpha
        await broker.call('node.assign' as never, {
            hostname: testHostname,
            services: [],
        } as never, asOperator);
    });

    it('operator gate: refuses admin caller with no operator role (403)', async () => {
        const adminCallerMeta = {
            meta: {
                user: { id: 'admin-user', tenant_id: 'customer-org', roles: ['admin'] },
            },
        };

        /**
         * **`hello` is the deliberate exception, and this assertion is inverted on purpose.**
         *
         * It used to demand that `hello` refuse a non-operator. A node has no user and never will
         * have one, so that rule means no machine can ever register — and the workaround it pushes
         * you toward, giving every box an operator credential, hands the fleet's whole control
         * surface to every box in the fleet.
         *
         * What keeps it safe is not a role check: `nodeHelloContract` is `internal`, so no site can
         * expose it (pinned by the test below), and a peer only reaches the broker at all by
         * presenting the shared key at the WebSocket handshake. Announcing yourself is not the same
         * act as directing somebody else, and only the second one is an operator's.
         */
        const announced = await broker.call(
            'node.hello' as never, { hostname: 'any-host' } as never, adminCallerMeta,
        ) as { hostname: string };
        expect(announced.hostname).toBe('any-host');

        await expect(
            broker.call('node.assign' as never, { hostname: 'any-host', services: [] } as never, adminCallerMeta),
        ).rejects.toThrow(/operator/i);

        await expect(
            broker.call('node.status' as never, {} as never, adminCallerMeta),
        ).rejects.toThrow(/operator/i);
    });

    it('operator gate: admits caller with operator role', async () => {
        const operatorCallerMeta = {
            meta: {
                user: { id: 'op-user', tenant_id: 'customer-org', roles: ['operator'] },
            },
        };

        const res = await broker.call(
            'node.status' as never,
            { hostname: testHostname } as never,
            operatorCallerMeta,
        ) as { hostname: string };

        expect(res.hostname).toBe(testHostname);
    });

    it('E4: nothing in src/fleet/ imports another service in this repository', () => {
        const fleetDir = path.resolve(__dirname, '../../src/fleet');
        const files: string[] = [];

        function collectFiles(dir: string): void {
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    collectFiles(fullPath);
                } else if (item.isFile() && item.name.endsWith('.ts')) {
                    files.push(fullPath);
                }
            }
        }

        collectFiles(fleetDir);
        expect(files.length).toBeGreaterThan(0);

        const forbiddenServices = ['api', 'builder', 'catalog', 'cdn', 'identity', 'supervisor'];

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('import') || line.trim().startsWith('export * from')) {
                    for (const svc of forbiddenServices) {
                        const regex = new RegExp(`from\\s+['"].*\\b${svc}\\b.*['"]`);
                        expect(
                            regex.test(line),
                            `File ${path.basename(file)} must not import from ${svc}: ${line}`,
                        ).toBe(false);
                    }
                }
            }
        }
    });

    it('E3: refuses second live node claiming an already live hostname', async () => {
        // Register a simulated live node in Registry
        const registry = app.registry;
        registry.registerNode({
            nodeID: 'conflicting-live-node',
            hostname: 'conflict-host',
            available: true,
            addresses: [],
            services: [],
            capabilities: { transports: [], features: [] },
            metadata: {},
            nodeSeq: 1,
            pid: 1,
            timestamp: Date.now(),
            bootedAt: Date.now(),
            cpu: 0,
            activeRequests: 0,
            healthScore: 1,
            trustLevel: 'internal',
            namespace: 'fleet-test',
        } as never);

        // Attempt hello from a different nodeID claiming the same hostname
        await expect(
            broker.call('node.hello' as never, { hostname: 'conflict-host' } as never),
        ).rejects.toThrow(/already claimed by live node/i);
    });

    /**
     * The check that makes `hello`'s missing operator gate defensible.
     *
     * If this contract ever becomes exposable, an unauthenticated caller on the internet can create
     * node rows and read other machines' assignments. mesh defaults a contract to `internal` and
     * `describeExposure` refuses to publish an internal one, so the property holds today — but it
     * holds by a default nobody restated, and a default nobody restated is a default somebody
     * eventually overrides.
     */
    it('node.hello is internal, which is what bounds its missing operator check', () => {
        const visibility = (nodeHelloContract as { visibility?: unknown }).visibility;

        // Undefined means internal (mesh's default). An explicit 'public' here would be the
        // regression this test exists to catch.
        expect(visibility === undefined || visibility === 'internal').toBe(true);
    });

    it('refuses an operator tool called with no caller at all', async () => {
        // Being on the mesh is not an identity — roadmap C2.5, no internal bypass.
        await expect(
            broker.call('node.assign' as never, { hostname: 'x', services: [] } as never),
        ).rejects.toThrow(/no caller/i);
    });

    describe('groups', () => {
        it('resolves a node\'s services as the union of its own and its groups', async () => {
            await broker.call('group.create' as never,
                { name: 'edge-test', services: ['alpha'] } as never, asOperator);

            const assigned = await broker.call('node.assign' as never, {
                hostname: 'grouped-host',
                services: ['beta'],
                groups: ['edge-test'],
            } as never, asOperator) as { services: string[] };

            expect(assigned.services).toEqual(['alpha', 'beta']);
        });

        /**
         * The whole reason a group stores a reference instead of an expanded list. If this failed,
         * every group edit would need a manual re-assign of every node in it, and the nodes nobody
         * remembered would go on running yesterday's set.
         */
        it('rolls a group edit onto the nodes that belong to it', async () => {
            const group = await broker.call('group.create' as never,
                { name: 'roll-test', services: ['alpha'] } as never, asOperator) as { id: string };

            await broker.call('node.assign' as never,
                { hostname: 'rolling-host', groups: ['roll-test'] } as never, asOperator);

            await broker.call('group.update' as never,
                { id: group.id, services: ['alpha', 'beta'] } as never, asOperator);

            const out = await broker.call('node.reconcile' as never,
                { group: 'roll-test' } as never, asOperator) as {
                    reconciled: { hostname: string; services: string[] }[];
                };

            const rolled = out.reconciled.find((r) => r.hostname === 'rolling-host');
            expect(rolled?.services).toEqual(['alpha', 'beta']);
        });

        it('does not clear direct services when only groups are given', async () => {
            // `absent means unchanged` — the mistake the obvious implementation makes, and one that
            // is invisible until a builder stops.
            await broker.call('node.assign' as never,
                { hostname: 'keep-host', services: ['alpha'] } as never, asOperator);

            const after = await broker.call('node.assign' as never,
                { hostname: 'keep-host', groups: [] } as never, asOperator) as { services: string[] };

            expect(after.services).toEqual(['alpha']);
        });

        it('treats a group that no longer exists as contributing nothing', async () => {
            // A group can be deleted while nodes still name it. Those nodes should lose its
            // services, not fail to reconcile and freeze on whatever they happened to be running.
            await broker.call('node.assign' as never,
                { hostname: 'ghost-host', groups: ['never-existed'] } as never, asOperator);

            const out = await broker.call('node.reconcile' as never,
                { hostname: 'ghost-host' } as never, asOperator) as {
                    reconciled: { services: string[] }[];
                };

            expect(out.reconciled[0]?.services).toEqual([]);
        });
    });
});
