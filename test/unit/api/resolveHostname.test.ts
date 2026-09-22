import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { ApiGateway } from '../../../src/api/gateway.js';

/**
 * A request through a real route (surfdns-proxy) connects to this node's own upstream address
 * (e.g. 127.0.0.1:5005), not the public hostname a client actually typed -- Node's http.request
 * sets the outgoing Host header to whatever address it connects to, unless told otherwise. The
 * proxy already sends the real one separately (x-forwarded-host, the standard header). Before this
 * fix, resolveHostname only ever read the raw Host header, so every request through a real route
 * resolved to "No api for host 127.0.0.1" instead of the api the client actually asked for.
 */
describe('ApiGateway.resolveHostname', () => {
    const gateway = new ApiGateway({} as never);
    const resolve = (headers: Record<string, string | string[] | undefined>): Promise<string> =>
        (gateway as unknown as { resolveHostname(req: IncomingMessage): Promise<string> })
            .resolveHostname({ headers } as IncomingMessage);

    it('prefers x-forwarded-host over Host, when a proxy set both', async () => {
        await expect(resolve({
            host: '127.0.0.1:5005',
            'x-forwarded-host': 'api.surfdns.net',
        })).resolves.toBe('api.surfdns.net');
    });

    it('falls back to Host when there is no x-forwarded-host -- a direct, unproxied hit', async () => {
        await expect(resolve({ host: 'api.surfdns.net:5005' })).resolves.toBe('api.surfdns.net');
    });

    it('strips the port from whichever header wins', async () => {
        await expect(resolve({
            host: '127.0.0.1:5005',
            'x-forwarded-host': 'api.surfdns.net:443',
        })).resolves.toBe('api.surfdns.net');
    });

    it('takes the first value when x-forwarded-host arrives as an array', async () => {
        await expect(resolve({
            host: '127.0.0.1:5005',
            'x-forwarded-host': ['api.surfdns.net', 'other.example.com'],
        })).resolves.toBe('api.surfdns.net');
    });

    it('still rejects a request with neither header', async () => {
        await expect(resolve({})).rejects.toThrow('No host header');
    });
});
