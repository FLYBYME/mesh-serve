/**
 * `start --metricsPort`: GET /metrics serves the node's own metrics as Prometheus text, and every
 * other path or method is a 404.
 *
 * The last case runs the real CLI in a child process, because what matters is the wiring in
 * `start` -- the flag parsed, the port bound to --host before the node joins, node info installed
 * once the broker exists -- and none of that is reachable by calling the pieces directly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MeshMetrics, MetricsRegistry } from '@flybyme/mesh';
import { installNodeMetrics } from '@flybyme/mesh/node';

import { resolveMetricsPort, startMetricsServer } from '../src/cli/core/metricsServer.js';

const ROOT = path.resolve(__dirname, '..');

async function get(url: string, method = 'GET'): Promise<{ status: number; type: string | null; body: string }> {
    const res = await fetch(url, { method });
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

describe('resolveMetricsPort', () => {
    it('takes the flag over the env, the env when there is no flag, and is off with neither', () => {
        expect(resolveMetricsPort(9464, '9000')).toBe(9464);
        expect(resolveMetricsPort(undefined, '9000')).toBe(9000);
        expect(resolveMetricsPort(undefined, undefined)).toBeUndefined();
        expect(resolveMetricsPort(undefined, ' ')).toBeUndefined();
    });

    it('a node bound to a private (fleet) address serves metrics at wsPort + 3000 unless told otherwise; public or loopback stays off', () => {
        expect(resolveMetricsPort(undefined, undefined, { host: '10.10.0.3', wsPort: 6005 })).toBe(9005);
        expect(resolveMetricsPort(undefined, undefined, { host: '192.168.1.4', wsPort: 6005 })).toBe(9005);
        expect(resolveMetricsPort(undefined, 'off', { host: '10.10.0.3', wsPort: 6005 })).toBeUndefined();
        expect(resolveMetricsPort(undefined, '9100', { host: '10.10.0.3', wsPort: 6005 })).toBe(9100);
        expect(resolveMetricsPort(undefined, undefined, { host: '0.0.0.0', wsPort: 6005 })).toBeUndefined();
        expect(resolveMetricsPort(undefined, undefined, { host: '51.79.1.2', wsPort: 6005 })).toBeUndefined();
        expect(resolveMetricsPort(undefined, undefined, { host: '127.0.0.1', wsPort: 6005 })).toBeUndefined();
    });

    it('refuses something that is not a port before anything binds', () => {
        expect(() => resolveMetricsPort(undefined, 'nine')).toThrow(/MESH_METRICS_PORT/);
        expect(() => resolveMetricsPort(70000, undefined)).toThrow(/--metricsPort/);
    });
});

describe('the metrics server', () => {
    it('serves GET /metrics as Prometheus text and 404s everything else', async () => {
        const metrics = new MeshMetrics(new MetricsRegistry());
        const uninstall = installNodeMetrics({ nodeID: 'metrics-unit', version: 'v0.0.0', metrics });
        const server = await startMetricsServer({ port: 0, host: '127.0.0.1', metrics });
        try {
            const base = `http://127.0.0.1:${server.port}`;
            const ok = await get(`${base}/metrics`);
            expect(ok.status).toBe(200);
            expect(ok.type).toBe('text/plain; version=0.0.4; charset=utf-8');
            expect(ok.body).toContain('mesh_node_info{node_id="metrics-unit",version="v0.0.0",mesh_version="unknown"} 1\n');
            expect(ok.body).toContain('# TYPE mesh_rpc_calls_total counter');

            expect((await get(`${base}/metrics?x=1`)).status).toBe(200);
            expect((await get(`${base}/`)).status).toBe(404);
            expect((await get(`${base}/metrics/extra`)).status).toBe(404);
            expect((await get(`${base}/api/serve.node.find`)).status).toBe(404);
            expect((await get(`${base}/metrics`, 'POST')).status).toBe(404);
        } finally {
            await server.close();
            uninstall();
        }
    });
});

describe('start --metricsPort', () => {
    let child: ChildProcess | undefined;
    let output = '';

    afterAll(async () => {
        if (child !== undefined && child.exitCode === null) {
            const exited = new Promise((resolve) => child?.once('exit', resolve));
            child.kill('SIGTERM');
            await exited;
        }
    });

    it('serves /metrics with this node\'s info on --host, and nothing else', async () => {
        const metricsPort = 16714;
        child = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [
            'src/cli/index.ts', 'start',
            '--nodeID', 'metrics-cli',
            '--wsPort', '16711', '--apiPort', '16712', '--cdnPort', '16713',
            '--metricsPort', String(metricsPort),
            '--db', 'metrics-port-test',
            '--logLevel', 'warn',
        ], { cwd: ROOT, env: { ...process.env, MESH_METRICS_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

        // Up once node info is there: it is installed after the broker exists, a moment after the
        // port itself is bound.
        const url = `http://127.0.0.1:${metricsPort}/metrics`;
        let body = '';
        const deadline = Date.now() + 40_000;
        while (Date.now() < deadline && !body.includes('mesh_node_info')) {
            if (child.exitCode !== null) throw new Error(`start exited early (${child.exitCode}):\n${output}`);
            try {
                body = (await get(url)).body;
            } catch {
                // Not listening yet.
            }
            if (!body.includes('mesh_node_info')) await new Promise((resolve) => setTimeout(resolve, 250));
        }

        expect(body).toMatch(/mesh_node_info\{node_id="metrics-cli",version="v[0-9.]+",mesh_version="v[0-9.]+"\} 1\n/);
        expect(body).toMatch(/mesh_registry_nodes\{available="true"\} [1-9]/);
        expect(body).toMatch(/mesh_event_loop_utilization [0-9.e-]+\n/);
        expect(body).toMatch(/\nprocess_resident_memory_bytes [1-9][0-9]*\n/);

        expect((await get(`http://127.0.0.1:${metricsPort}/`)).status).toBe(404);
        expect((await get(`http://127.0.0.1:${metricsPort}/health`)).status).toBe(404);
    }, 60_000);
});
