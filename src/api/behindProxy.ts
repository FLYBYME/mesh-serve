import type http from 'node:http';

/**
 * How long a server behind the edge proxy keeps an idle connection: longer than the proxy keeps one
 * in its pool, so the proxy is always the side that closes it.
 *
 * Node's default is 5 s. The proxy keeps upstream connections alive and reuses them; a request it
 * sent on one just as the server closed it for idling died with "socket hang up" / "read
 * ECONNRESET", answered as 502 -- twelve times in three hours on one-host.ca (10-16), every one a
 * request coming a few seconds after the one before (a part imported, then the next). 65 s is the
 * usual figure for a server behind a load balancer.
 */
export const IDLE_KEEP_ALIVE_MS = 65_000;

/** A server's keep-alive set for life behind the edge proxy. Headers wait a second longer, as Node requires. */
export function behindProxy(server: http.Server): http.Server {
    server.keepAliveTimeout = IDLE_KEEP_ALIVE_MS;
    server.headersTimeout = IDLE_KEEP_ALIVE_MS + 1_000;

    return server;
}
