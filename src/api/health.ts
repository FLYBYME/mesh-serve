import type http from 'node:http';

import type { Database, IServiceBroker } from '@flybyme/mesh';

/** The path the proxy's health check asks by default (surfdns-routes `balancer.healthCheck.path`). */
export const HEALTH_PATH = '/health';

const DATABASE_TIMEOUT_MS = 2000;

/**
 * Answers `GET|HEAD /health` on the api and website servers, before anything looks at the hostname
 * (the proxy probes an upstream by its address, not by a site's name -- every other path would be a
 * 404 there). 200 only when this node could actually serve a request: it answers, and its database
 * answers a ping within 2 s -- every api call and every page needs the database. 503 otherwise, so
 * the proxy takes this copy out of rotation until it is back. Nothing secret in the body.
 */
export async function answerHealth(broker: IServiceBroker, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    if ((req.url ?? '').split('?')[0] !== HEALTH_PATH || (method !== 'GET' && method !== 'HEAD')) return false;

    const database = await pingDatabase(broker);
    const ok = database === 'ok';
    const body = JSON.stringify({ ok, nodeID: broker.nodeID, database, uptimeSeconds: Math.round(process.uptime()) });
    res.statusCode = ok ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(method === 'HEAD' ? undefined : body);
    return true;
}

async function pingDatabase(broker: IServiceBroker): Promise<'ok' | 'unreachable'> {
    // getProvider returns undefined for a provider this node never registered.
    const db = broker.getProvider<Database | undefined>('database')?.getDb();
    if (!db) return 'unreachable';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'unreachable'>((resolve) => { timer = setTimeout(() => resolve('unreachable'), DATABASE_TIMEOUT_MS); });
    try {
        return await Promise.race([db.command({ ping: 1 }).then((): 'ok' => 'ok', (): 'unreachable' => 'unreachable'), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
