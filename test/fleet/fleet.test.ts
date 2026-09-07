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
        } as never);

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
        } as never) as {
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
        } as never) as {
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
        } as never) as {
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
        } as never) as {
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
        } as never);

        const status = await broker.call('node.status' as never, {
            hostname: testHostname,
        } as never) as {
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
        } as never) as {
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
        } as never);
    });

    it('operator gate: refuses admin caller with no operator role (403)', async () => {
        const adminCallerMeta = {
            meta: {
                user: { id: 'admin-user', tenant_id: 'customer-org', roles: ['admin'] },
            },
        };

        await expect(
            broker.call('node.hello' as never, { hostname: 'any-host' } as never, adminCallerMeta),
        ).rejects.toThrow(/operator/i);

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
});
