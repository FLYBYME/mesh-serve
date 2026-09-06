/**
 * **M2 C4: The edge registry across multiple nodes on a mesh.**
 *
 * Assertions:
 * 1. Two cdn services on one mesh, both registered.
 * 2. Each edge able to read the other's row.
 * 3. A stopped edge's row is removed on clean shutdown.
 *
 * Needs mongo on `MONGODB_URI` (default `mongodb://localhost:27017`). Skipped when unreachable.
 */

import {
    BrokerModule, DatabaseModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CdnService } from '../../src/cdn/cdn.service.js';

const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://localhost:27017';

const reachable = await (async (): Promise<boolean> => {
    try {
        const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        await client.close();
        return true;
    } catch {
        return false;
    }
})();

describe('the edge registry on a mesh', () => {
    let app1: MeshApp | undefined;
    let app2: MeshApp | undefined;
    let cdn1: CdnService | undefined;
    let cdn2: CdnService | undefined;
    let dbName: string;

    beforeAll(async () => {
        if (!reachable) return;

        dbName = `mesh-serve-edge-test-${String(Date.now())}`;

        // Node 1: MeshApp with WSTransport on an ephemeral port
        const transport1 = new WSTransport(new JSONSerializer(), 0);
        const node1 = new MeshApp({
            nodeID: `edge-node-1-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-serve-edge-test',
        });
        node1.use(new RegistryModule());
        node1.use(new DatabaseModule({ uri: MONGO, dbName }));
        node1.use(new NetworkModule({ transports: [transport1] }));
        node1.use(new BrokerModule());
        await node1.start();
        const wsPort1 = transport1.getPort();

        const service1 = new CdnService({ port: 0 });
        await node1.registerModule(service1);

        // Node 2: MeshApp bootstrapping from Node 1
        const transport2 = new WSTransport(new JSONSerializer(), 0);
        const node2 = new MeshApp({
            nodeID: `edge-node-2-${String(Math.random()).slice(2, 8)}`,
            namespace: 'mesh-serve-edge-test',
        });
        node2.use(new RegistryModule());
        node2.use(new DatabaseModule({ uri: MONGO, dbName }));
        node2.use(new NetworkModule({
            transports: [transport2],
            bootstrapNodes: [`ws://127.0.0.1:${String(wsPort1)}`],
        }));
        node2.use(new BrokerModule());
        await node2.start();

        const service2 = new CdnService({ port: 0 });
        await node2.registerModule(service2);

        // Await mesh peer discovery so both nodes know about each other
        await node1.registry.waitForNodes(2);
        await node2.registry.waitForNodes(2);

        app1 = node1;
        app2 = node2;
        cdn1 = service1;
        cdn2 = service2;
    }, 60_000);

    afterAll(async () => {
        if (app2 !== undefined) {
            try { await app2.stop(); } catch { /* ignore */ }
        }
        if (app1 !== undefined) {
            try { await app1.stop(); } catch { /* ignore */ }
        }
        if (reachable) {
            try {
                const client = new MongoClient(MONGO);
                await client.connect();
                await client.db(dbName).dropDatabase();
                await client.close();
            } catch {
                /* ignore */
            }
        }
    });

    it('both edges self-register on start with their bound URLs', async () => {
        if (!reachable || app1 === undefined || app2 === undefined || cdn1 === undefined || cdn2 === undefined) {
            return;
        }

        expect(cdn1.edgeId).toBeDefined();
        expect(cdn1.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        expect(cdn2.edgeId).toBeDefined();
        expect(cdn2.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        // Ensure distinct endpoints
        expect(cdn1.edgeId).not.toBe(cdn2.edgeId);
        expect(cdn1.url).not.toBe(cdn2.url);
    });

    it('each edge is able to read the other edge row from the registry', async () => {
        if (!reachable || app1 === undefined || app2 === undefined || cdn1 === undefined || cdn2 === undefined) {
            return;
        }

        const edgeId1 = cdn1.edgeId;
        const edgeId2 = cdn2.edgeId;
        if (edgeId1 === undefined || edgeId2 === undefined) {
            throw new Error('Expected edge IDs to be defined');
        }

        // Edge 1 reads all registered edges
        const rowsFromNode1 = await app1.call('edge.find', {});
        expect(rowsFromNode1.length).toBe(2);
        const idsOn1 = rowsFromNode1.map((r) => r.id);
        expect(idsOn1).toContain(edgeId1);
        expect(idsOn1).toContain(edgeId2);

        // Edge 1 reads Edge 2 specifically by ID
        const edge2FromNode1 = await app1.call('edge.get', { id: edgeId2 });
        expect(edge2FromNode1.id).toBe(edgeId2);
        expect(edge2FromNode1.url).toBe(cdn2.url);

        // Edge 2 reads all registered edges
        const rowsFromNode2 = await app2.call('edge.find', {});
        expect(rowsFromNode2.length).toBe(2);
        const idsOn2 = rowsFromNode2.map((r) => r.id);
        expect(idsOn2).toContain(edgeId1);
        expect(idsOn2).toContain(edgeId2);

        // Edge 2 reads Edge 1 specifically by ID
        const edge1FromNode2 = await app2.call('edge.get', { id: edgeId1 });
        expect(edge1FromNode2.id).toBe(edgeId1);
        expect(edge1FromNode2.url).toBe(cdn1.url);
    });

    it('a stopped edge removes its row on clean shutdown', async () => {
        if (!reachable || app1 === undefined || app2 === undefined || cdn1 === undefined || cdn2 === undefined) {
            return;
        }

        const edgeId1 = cdn1.edgeId;
        const edgeId2 = cdn2.edgeId;
        if (edgeId1 === undefined || edgeId2 === undefined) {
            throw new Error('Expected edge IDs to be defined');
        }

        // Clean shutdown of Node 2
        await app2.stop();
        app2 = undefined;

        // Node 1 should now see only its own row
        const rowsAfterStop = await app1.call('edge.find', {});
        expect(rowsAfterStop.length).toBe(1);
        const remaining = rowsAfterStop[0];
        if (remaining === undefined) {
            throw new Error('Expected at least one registered edge');
        }
        expect(remaining.id).toBe(edgeId1);

        // Resolving Node 2's edge ID now yields undefined
        const resolved = await app1.call('edge.resolve', { id: edgeId2 });
        expect(resolved).toBeUndefined();

        // Clean shutdown of Node 1 as well
        await app1.stop();
        app1 = undefined;

        // Verify with MongoDB directly that all edge rows are removed on clean shutdown
        const client = new MongoClient(MONGO);
        await client.connect();
        const remainingCount = await client.db(dbName).collection('edge').countDocuments();
        await client.close();
        expect(remainingCount).toBe(0);
    });
});
