import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { ApiGateway } from '../src/api/gateway.js';

/**
 * GET /health on the api server, as the proxy's health check asks it: by address, with no site's
 * hostname. 200 only while the node's database answers.
 */
async function node(nodeID: string, ws: number, withDatabase: boolean): Promise<MeshApp> {
    const app = new MeshApp({ nodeID, logger: new Logger(LogLevel.ERROR) });
    app.use(new RegistryModule({ implementation: PlacementRegistry }));
    app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), ws, '127.0.0.1')] }));
    if (withDatabase) app.use(new DatabaseModule({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017', dbName: 'mesh-serve-health-test' }));
    app.use(new BrokerModule());
    await app.start();
    return app;
}

describe('the api server\'s /health', () => {
    const apps: MeshApp[] = [];
    const gateways: ApiGateway[] = [];
    let healthy = '';
    let noDatabase = '';

    const serve = async (app: MeshApp): Promise<string> => {
        const gateway = new ApiGateway(app.getProvider<IServiceBroker>('broker'));
        gateways.push(gateway);
        return `http://${await gateway.start(0, '127.0.0.1')}`;
    };

    beforeAll(async () => {
        // 16583-4: 16581 is nodeLabels', and two files on one port fail each other in a parallel run.
        apps.push(await node('health-ok', 16583, true), await node('health-nodb', 16584, false));
        healthy = await serve(apps[0]!);
        noDatabase = await serve(apps[1]!);
    }, 30000);

    afterAll(async () => {
        for (const g of gateways) await g.stop();
        for (const a of apps) await a.stop();
    });

    it('answers 200 by address, with no site\'s hostname, while the database answers', async () => {
        const res = await fetch(`${healthy}/health`, { headers: { Host: '10.10.0.5:5005' } });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, nodeID: 'health-ok', database: 'ok' });
        expect((await fetch(`${healthy}/health`, { method: 'HEAD' })).status).toBe(200);
    });

    it('answers 503 when this node cannot reach a database, so the proxy takes it out', async () => {
        const res = await fetch(`${noDatabase}/health`);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ ok: false, database: 'unreachable' });
    });
});
