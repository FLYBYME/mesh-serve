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

/** A private IPv4 address (10/8, 172.16/12, 192.168/16): a fleet address, never the internet's. */
export function isPrivateAddress(host: string): boolean {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a = -1, b = -1] = parts;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * `--metricsPort`, else MESH_METRICS_PORT (`off` turns it off), else -- on a node bound to a private
 * address -- `wsPort + 3000`, the pods' own convention; else off. Until 2026-10-02 the default was
 * off, and the host nodes (edge1, ns1, ns2, surf, compute1) served no metrics: each needed a line
 * in its node.env, and only SSH could put it there. A private bind is the fleet's, and so is the
 * metrics port (no auth on it): a public or loopback bind keeps it off. Checked before the node
 * binds anything, like --parts and --labels, so a typo fails before the node joins a cluster.
 */
export function resolveMetricsPort(
    flag: number | undefined,
    env: string | undefined = process.env.MESH_METRICS_PORT,
    bind?: { host: string; wsPort: number },
): number | undefined {
    if (flag !== undefined) return checkedPort(flag, '--metricsPort');
    if (env !== undefined && env.trim().toLowerCase() === 'off') return undefined;
    if (env !== undefined && env.trim() !== '') return checkedPort(Number(env), `MESH_METRICS_PORT ("${env}")`);
    if (bind !== undefined && isPrivateAddress(bind.host)) return checkedPort(bind.wsPort + 3000, '--wsPort + 3000');
    return undefined;
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
