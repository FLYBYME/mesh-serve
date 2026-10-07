import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    BrokerModule, DatabaseModule, JSONSerializer, Logger, LogLevel, MeshApp, NetworkModule, PlacementRegistry, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker, Span } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { ApiGateway } from '../src/api/gateway.js';
import { formatTraceparent, readTraceparent } from '../src/api/methods/traceparent.js';

/**
 * Every api response names its trace (W3C traceparent), the node that took the request and its
 * release; a request that brings a trace runs in it. Before, nothing in a response said where it
 * came from: two versions of identity answered differently and it took hours to see which
 * (2026-10-06).
 */
describe('a response says where it came from', () => {
    let app: MeshApp;
    let gateway: ApiGateway;
    let base = '';

    beforeAll(async () => {
        app = new MeshApp({ nodeID: 'trace-gw', logger: new Logger(LogLevel.ERROR) });
        app.use(new RegistryModule({ implementation: PlacementRegistry }));
        app.use(new NetworkModule({ transports: [new WSTransport(new JSONSerializer(), 16586, '127.0.0.1')] }));
        app.use(new DatabaseModule({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017', dbName: 'mesh-serve-trace-test' }));
        app.use(new BrokerModule());
        await app.start();
        gateway = new ApiGateway(app.getProvider<IServiceBroker>('broker'));
        base = `http://${await gateway.start(0, '127.0.0.1')}`;
    }, 30000);

    afterAll(async () => {
        await gateway.stop();
        await app.stop();
    });

    it('records the request as its trace\'s root span, and no span for a health probe', async () => {
        const spans: Span[] = [];
        app.getProvider<IServiceBroker>('broker').setSpanSink?.((s) => spans.push(s));

        const sent = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
        const res = await fetch(`${base}/api/no-such-thing?x=1`, { headers: { traceparent: sent } });
        await res.text();
        await fetch(`${base}/health`).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 50));
        app.getProvider<IServiceBroker>('broker').setSpanSink?.(undefined);

        const request = spans.find((s) => s.name === 'GET /api/no-such-thing');
        expect(request).toMatchObject({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentId: '00f067aa0ba902b7', kind: 'call', nodeID: 'trace-gw' });
        // Everything the request did is under it: here, its lookup of the api by host.
        const inner = spans.filter((s) => s !== request);
        expect(inner.length).toBeGreaterThan(0);
        expect(inner.every((s) => s.traceId === request?.traceId && s.parentId === request?.spanId)).toBe(true);
        expect(spans.some((s) => s.name.includes('/health'))).toBe(false);
        expect(readTraceparent(res.headers.get('traceparent') ?? undefined)?.traceId).toBe(request?.traceId);
    });

    it('names a new trace, the node and its release, and lets a browser read them', async () => {
        const res = await fetch(`${base}/health`);

        const trace = readTraceparent(res.headers.get('traceparent') ?? undefined);
        expect(trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(res.headers.get('x-mesh-gateway')).toBe('trace-gw');
        // No catalog on this test node to ask: said, but unknown (twoNode's nodes say their release).
        expect(res.headers.get('x-mesh-version')).toBe('unknown');
        expect(res.headers.get('access-control-expose-headers')).toContain('traceparent');
    });

    it('keeps the trace a request brings, under a span of its own', async () => {
        const sent = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');

        const res = await fetch(`${base}/health`, { headers: { traceparent: sent } });

        const back = res.headers.get('traceparent') ?? '';
        expect(readTraceparent(back)?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(back).not.toBe(sent);
    });

    it('two requests, two traces', async () => {
        const one = readTraceparent((await fetch(`${base}/health`)).headers.get('traceparent') ?? undefined);
        const two = readTraceparent((await fetch(`${base}/health`)).headers.get('traceparent') ?? undefined);

        expect(one?.traceId).not.toBe(two?.traceId);
    });
});

describe('reading a traceparent', () => {
    it('takes a valid one, and ignores what the spec says to ignore', () => {
        expect(readTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7' });
        expect(readTraceparent(undefined)).toBeUndefined();
        expect(readTraceparent('garbage')).toBeUndefined();
        expect(readTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
        expect(readTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeUndefined();
        expect(readTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeUndefined();
    });
});
