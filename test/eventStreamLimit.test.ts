import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { defineEvent, z } from '@flybyme/mesh';
import { openStream } from '../src/api/methods/events.js';

// An organization's event, as every streamed one is: delivery reads whose it is from its definition.
defineEvent('limittest.changed', z.object({ tenantId: z.string(), item: z.string() }), { scopedBy: 'tenantId' });

/**
 * A reader that stops reading is dropped once its unsent events pass the stream's limit, and its
 * subscriptions go with it. Before, every event piled up in the api's memory for as long as the
 * connection stayed open: edge1 grew 100 MB an hour (2026-10-08). A real server, a real client that
 * connects and then never reads.
 */
describe('an event stream whose reader stops reading', () => {
    let server: http.Server;
    let port = 0;
    const handlers: Array<(payload: unknown) => void> = [];
    let unsubscribed = 0;
    let closedOnServer = false;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            res.on('close', () => { closedOnServer = true; });
            openStream({
                res,
                events: ['limittest.changed'],
                omitted: [],
                subscriber: { scope: 'platform', operator: true },
                hub: {
                    subscribe: (_name, fn) => {
                        handlers.push(fn);
                        return () => { unsubscribed++; };
                    },
                },
                recheck: async () => ({ scope: 'platform', operator: true }),
                maxUnsentBytes: 256 * 1024,
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const address = server.address();
        port = typeof address === 'object' && address !== null ? address.port : 0;
    });

    afterAll(() => {
        server.close();
    });

    it('is dropped past the limit, its subscription removed', async () => {
        const client = net.connect(port, '127.0.0.1');
        await new Promise<void>((r) => client.once('connect', () => r()));
        client.write('GET /api/events HTTP/1.1\r\nHost: api.test\r\n\r\n');
        client.pause();
        await new Promise<void>((r) => {
            const wait = (): void => { if (handlers.length > 0) r(); else setTimeout(wait, 10); };
            wait();
        });

        // Far more than the kernel's socket buffers and the limit together: a 4 KB event, 20 000 times.
        // An event of one organization's (one with none is never delivered, even to an operator).
        const payload = { tenantId: 'org-a', item: 'x'.repeat(4096) };
        for (let i = 0; i < 20_000 && !closedOnServer; i++) {
            for (const fn of handlers) fn(payload);
            if (i % 200 === 0) await new Promise((r) => setImmediate(r));
        }

        // The connection's close is reported a tick after it is dropped.
        for (let i = 0; i < 100 && !closedOnServer; i++) await new Promise((r) => setTimeout(r, 10));

        expect(closedOnServer).toBe(true);
        expect(unsubscribed).toBe(1);
        client.destroy();
    });
});
