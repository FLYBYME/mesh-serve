/**
 * `serve.node.links` / `serve.node.mesh`: a cluster's link state from the platform itself.
 *
 * The only way to see a broken mesh used to be `ss` on every node over SSH. Here each node answers
 * for its own links, and `serve.node.mesh` asks them all and names the missing pairs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, RegistryModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { nodeLinksContract, nodeMeshContract } from '../src/catalog/contracts/node.contract.js';
import { nodeLinks } from '../src/catalog/tools/nodeLinks.js';
import { nodeMesh } from '../src/catalog/tools/nodeMesh.js';
import { missingPairs } from '../src/catalog/methods/meshPairs.js';

const settle = (ms = 800): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function node(nodeID: string, port: number, bootstrap: string[]): Promise<MeshApp> {
    const app = new MeshApp({ nodeID, logger: new Logger(LogLevel.ERROR) });
    app.use(new RegistryModule());
    app.use(new NetworkModule({
        port,
        transports: [new WSTransport(new JSONSerializer(), port, '127.0.0.1')],
        bootstrapNodes: bootstrap,
    }));
    app.use(new BrokerModule());
    await app.start();
    const broker = app.getProvider<IServiceBroker>('broker');
    broker.registerContract(nodeLinksContract, nodeLinks);
    broker.registerContract(nodeMeshContract, nodeMesh);
    return app;
}

describe('the mesh at a glance', () => {
    let a: MeshApp;
    let b: MeshApp;
    let c: MeshApp;

    beforeAll(async () => {
        a = await node('mesh-a', 16591, []);
        b = await node('mesh-b', 16592, ['ws://127.0.0.1:16591']);
        // c dials only a: whether b and c end up linked depends on PEX, so the test below cuts it
        // deliberately rather than relying on either outcome.
        c = await node('mesh-c', 16593, ['ws://127.0.0.1:16591']);
        await settle(1500);
    }, 30000);

    afterAll(async () => {
        await c?.stop();
        await b?.stop();
        await a?.stop();
    });

    it('answers for each node from that node, and reports a full mesh as complete', async () => {
        const mesh = await a.getProvider<IServiceBroker>('broker').call('serve.node.mesh', {});

        expect(mesh.nodes.map((n) => n.nodeID)).toEqual(['mesh-a', 'mesh-b', 'mesh-c']);
        expect(mesh.nodes.find((n) => n.nodeID === 'mesh-a')?.links).toEqual(['mesh-b', 'mesh-c']);
        expect(mesh.missing).toEqual([]);
        expect(mesh.complete).toBe(true);
    });

    it('answers links for the node asked, from that node', async () => {
        const links = await a.getProvider<IServiceBroker>('broker').call('serve.node.links', {}, { nodeID: 'mesh-b' });
        expect(links.nodeID).toBe('mesh-b');
        expect(links.links.map((l) => l.nodeID)).toContain('mesh-a');
    });
});

describe('missingPairs', () => {
    it('names every pair no side reports, and only those', () => {
        // The live cluster's failure shape: a star around one node.
        const star = [
            { nodeID: 'surf', links: ['edge1', 'ns1', 'ns2'] },
            { nodeID: 'edge1', links: ['surf'] },
            { nodeID: 'ns1', links: ['surf'] },
            { nodeID: 'ns2', links: ['surf'] },
        ];
        expect(missingPairs(star)).toEqual([
            { a: 'edge1', b: 'ns1' },
            { a: 'edge1', b: 'ns2' },
            { a: 'ns1', b: 'ns2' },
        ]);
    });

    it('counts a link one side reports and the other has not yet', () => {
        expect(missingPairs([{ nodeID: 'a', links: ['b'] }, { nodeID: 'b', links: [] }])).toEqual([]);
    });
});
