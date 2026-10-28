import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@flybyme/mesh';

import { MetricLines, resolveTelemetryMode, spanLine } from '../src/cli/core/telemetryLines.js';

function parsed(lines: string[]): Array<Record<string, unknown>> {
    return lines.map((line): Record<string, unknown> => JSON.parse(line));
}

describe('telemetry lines', () => {
    it('writes every span unless MESH_SPANS=failed', () => {
        expect(resolveTelemetryMode(undefined)).toBe('all');
        expect(resolveTelemetryMode('1')).toBe('all');
        expect(resolveTelemetryMode(' Failed ')).toBe('failed');
        expect(JSON.parse(spanLine({
            traceId: 't', spanId: 's', kind: 'call', name: 'a.b', nodeID: 'n1', from: 'n2', startedAt: 1, durationMs: 2, outcome: 'ok',
        }))).toMatchObject({ type: 'span', name: 'a.b', from: 'n2' });
    });

    it('writes the series that changed, and all of them once a minute', () => {
        const registry = new MetricsRegistry();
        const calls = registry.counter('mesh_test_calls', 'calls', ['action']);
        calls.inc(['a.b']);
        calls.inc(['c.d']);
        const written: string[] = [];
        let now = 0;
        const lines = new MetricLines({ registry, nodeID: 'n1', write: (line) => written.push(line), now: () => now });

        lines.tick();
        expect(parsed(written)).toEqual([{
            type: 'metric', nodeID: 'n1', at: 0, full: true, name: 'mesh_test_calls', metricType: 'counter', labelNames: ['action'],
            series: [{ labels: ['a.b'], value: 1 }, { labels: ['c.d'], value: 1 }],
        }]);

        written.length = 0;
        now = 5_000;
        calls.inc(['c.d']);
        lines.tick();
        expect(parsed(written)).toMatchObject([{ full: false, series: [{ labels: ['c.d'], value: 2 }] }]);

        written.length = 0;
        now = 10_000;
        lines.tick();
        expect(written).toEqual([]);

        now = 60_000;
        lines.tick();
        expect(parsed(written)).toMatchObject([{ full: true, series: [{ labels: ['a.b'] }, { labels: ['c.d'] }] }]);
    });

    it('splits a metric with many series over several lines', () => {
        const registry = new MetricsRegistry();
        const calls = registry.counter('mesh_test_calls', 'calls', ['action']);
        for (let i = 0; i < 120; i++) calls.inc([`a.${i}`]);
        const written: string[] = [];
        new MetricLines({ registry, nodeID: 'n1', write: (line) => written.push(line) }).tick();

        expect(parsed(written).map((line) => Array.isArray(line.series) ? line.series.length : 0)).toEqual([50, 50, 20]);
    });
});
