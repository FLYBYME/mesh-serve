import type { MetricsRegistry, SeriesSnapshot, Span } from '@flybyme/mesh';

/**
 * What a node says about its own work, as typed JSON lines on stdout: one `span` line per call,
 * event and database operation, and `metric` lines every few seconds. Whatever ships the node's
 * stdout carries them; nothing here waits on a collector, and nothing travels the mesh.
 *
 * `MESH_SPANS=failed` writes failed spans only and no metric lines (what a node did before 10-28);
 * anything else, unset included, writes everything.
 */

export type TelemetryMode = 'all' | 'failed';

export function resolveTelemetryMode(env: string | undefined = process.env.MESH_SPANS): TelemetryMode {
    return env?.trim().toLowerCase() === 'failed' ? 'failed' : 'all';
}

export function spanLine(span: Span): string {
    return JSON.stringify({ type: 'span', ...span });
}

/** Series per line: a log shipper drops a line past its buffer (Fluent Bit's is 32 KB). */
const SERIES_PER_LINE = 50;

export interface MetricLinesOptions {
    readonly registry: MetricsRegistry;
    readonly nodeID: string;
    readonly write: (line: string) => void;
    /** Every series, changed or not, this often; between, only the ones that changed. */
    readonly fullEveryMs?: number;
    readonly now?: () => number;
}

/**
 * The registry as `metric` lines: per metric, the series that changed since the last tick, every
 * one of them once a minute (so a reader that starts late, or lost a line, is whole within a
 * minute). Values are cumulative as the registry holds them; a window's rate is the difference
 * of two.
 */
export class MetricLines {
    private readonly last = new Map<string, string>();
    private lastFull = Number.NEGATIVE_INFINITY;

    constructor(private readonly options: MetricLinesOptions) {}

    tick(): void {
        const now = this.options.now ?? Date.now;
        const at = now();
        const full = at - this.lastFull >= (this.options.fullEveryMs ?? 60_000);
        if (full) this.lastFull = at;

        for (const metric of this.options.registry.snapshot()) {
            const changed = metric.series.filter((series) => this.changed(metric.name, series) || full);

            for (let i = 0; i < changed.length; i += SERIES_PER_LINE) {
                this.options.write(JSON.stringify({
                    type: 'metric', nodeID: this.options.nodeID, at, full,
                    name: metric.name, metricType: metric.type, labelNames: metric.labelNames,
                    ...(metric.buckets !== undefined ? { buckets: metric.buckets } : {}),
                    series: changed.slice(i, i + SERIES_PER_LINE),
                }));
            }
        }
    }

    /** Records the series' current value, and says whether it differs from the one written last. */
    private changed(name: string, series: SeriesSnapshot): boolean {
        const key = `${name}\u0000${series.labels.join('\u0000')}`;
        // A histogram's buckets move only with its count and sum.
        const value = `${series.value ?? ''}/${series.count ?? ''}/${series.sum ?? ''}`;
        if (this.last.get(key) === value) return false;

        this.last.set(key, value);

        return true;
    }
}
