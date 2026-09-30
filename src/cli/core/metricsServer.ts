import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { meshMetrics, PROMETHEUS_CONTENT_TYPE, type MeshMetrics } from '@flybyme/mesh';

import { findPackageRoot } from '../../catalog/methods/corePartPath.js';

/**
 * `start --metricsPort`: this node's own metrics (mesh's MeshMetrics -- calls, their durations,
 * bytes per topic, event loop, CPU, memory) as Prometheus text, for the fleet's VictoriaMetrics.
 *
 * Added after 2026-09-30, when every node burned half a core on gossip and api calls took seconds,
 * and the only way to see why was counting WebSocket bytes by hand. With this the same answer is a
 * graph.
 *
 * GET /metrics and nothing else: every other path and method is a 404, so the port can't be
 * mistaken for (or grow into) an api. No auth -- it binds the same address as the mesh transport
 * (`--host`), which on the fleet is the node's private address, and says only what a node is
 * doing, never data it holds.
 */

export interface MetricsServerOptions {
    /** 0 picks a free port -- the tests' case; `port` on the result says which. */
    readonly port: number;
    readonly host: string;
    /** Defaults to the process-wide `meshMetrics`, which the broker and transport record into. */
    readonly metrics?: MeshMetrics;
}

export interface MetricsServer {
    readonly port: number;
    readonly host: string;
    close(): Promise<void>;
}

export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
    const metrics = options.metrics ?? meshMetrics;

    const server = http.createServer((req, res) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (req.method !== 'GET' || pathname !== '/metrics') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found\n');
            return;
        }
        let body: string;
        try {
            body = metrics.registry.render();
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`${err instanceof Error ? err.message : String(err)}\n`);
            return;
        }
        res.writeHead(200, { 'Content-Type': PROMETHEUS_CONTENT_TYPE });
        res.end(body);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = isAddressInfo(address) ? address.port : options.port;
    return {
        port,
        host: options.host,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function isAddressInfo(value: unknown): value is AddressInfo {
    return typeof value === 'object' && value !== null && 'port' in value && typeof value.port === 'number';
}

/**
 * `--metricsPort`, else MESH_METRICS_PORT, else off. Checked before the node binds anything, like
 * --parts and --labels, so a typo fails before the node joins a cluster.
 */
export function resolveMetricsPort(flag: number | undefined, env: string | undefined = process.env.MESH_METRICS_PORT): number | undefined {
    if (flag !== undefined) return checkedPort(flag, '--metricsPort');
    if (env === undefined || env.trim() === '') return undefined;
    return checkedPort(Number(env), `MESH_METRICS_PORT ("${env}")`);
}

function checkedPort(port: number, source: string): number {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`${source} is not a port number (0-65535).`);
    }
    return port;
}

/** The @flybyme/mesh release this process loaded, from its own package.json -- 'unknown' if unreadable. */
export function meshFrameworkVersion(): string {
    try {
        const entry = createRequire(import.meta.url).resolve('@flybyme/mesh');
        const pkg: unknown = JSON.parse(readFileSync(path.join(findPackageRoot(path.dirname(entry)), 'package.json'), 'utf8'));
        return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? `v${pkg.version}` : 'unknown';
    } catch {
        return 'unknown';
    }
}
