import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { behindProxy, IDLE_KEEP_ALIVE_MS } from '../src/api/behindProxy.js';

/** One GET through `agent`; whether it went over a connection the agent already had. */
function get(port: number, agent: http.Agent): Promise<{ reused: boolean }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ port, host: '127.0.0.1', path: '/', agent }, (res) => {
            res.resume();
            res.on('end', () => resolve({ reused: req.reusedSocket }));
        });
        req.on('error', reject);
    });
}

describe('a server behind the edge proxy', () => {
    const servers: http.Server[] = [];
    const agents: http.Agent[] = [];

    afterEach(async () => {
        for (const a of agents.splice(0)) a.destroy();
        for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    });

    async function serve(server: http.Server): Promise<number> {
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        return (server.address() as AddressInfo).port;
    }

    it('keeps an idle connection longer than the proxy does, as Node\'s 5 s did not', () => {
        const server = behindProxy(http.createServer((_req, res) => res.end('ok')));

        expect(IDLE_KEEP_ALIVE_MS).toBeGreaterThan(60_000);
        expect(server.keepAliveTimeout).toBe(IDLE_KEEP_ALIVE_MS);
        expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    });

    it('a request 6 s after the last goes over the same connection -- the one the proxy would reuse (one-host.ca, 10-16: "socket hang up")', async () => {
        const port = await serve(behindProxy(http.createServer((_req, res) => res.end('ok'))));
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        agents.push(agent);

        expect((await get(port, agent)).reused).toBe(false);
        await new Promise((r) => setTimeout(r, 6_000));
        expect((await get(port, agent)).reused).toBe(true);
    }, 15_000);
});
