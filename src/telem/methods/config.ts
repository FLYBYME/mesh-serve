/**
 * Per-site telemetry configuration and sampling.
 *
 * ## "A logger nobody can turn down is a logger somebody turns off."
 *
 * Configurable from the site record (via `site.policy` or `site.telemetry`),
 * not a constant and not an environment variable on one node.
 *
 * Defaults to something a person would accept:
 * - errors: always (1.0)
 * - boot: always (1.0)
 * - calls: sampled (default 0.1 = 10%)
 * - debug: off (minLevel = 'info')
 */

import type { TelemLevel, TelemType } from '../schema/telem.js';

export interface TelemConfig {
    readonly enabled: boolean;
    readonly minLevel: TelemLevel;
    readonly sampleRates: {
        readonly call: number;
        readonly log: number;
        readonly boot: number;
        readonly error: number;
        readonly request: number;
    };
}

export const LEVEL_SEVERITY: Record<TelemLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export const DEFAULT_TELEM_CONFIG: TelemConfig = {
    enabled: true,
    minLevel: 'info',
    sampleRates: {
        error: 1.0,   // Errors always kept
        boot: 1.0,    // Boot always kept
        call: 0.1,    // Calls sampled at 10%
        log: 1.0,     // Logs at or above minLevel
        request: 1.0, // HTTP requests
    },
};

interface SiteLike {
    readonly policy?: Readonly<Record<string, string>>;
    readonly telem?: unknown;
    readonly telemetry?: unknown;
}

/**
 * Resolve telemetry configuration for a site.
 *
 * Reads from `site.policy` keys:
 * - `telem.disabled`: 'true' to disable telemetry
 * - `telem.level`: 'debug' | 'info' | 'warn' | 'error'
 * - `telem.sample.calls`: '0.0' - '1.0'
 * - `telem.sample.logs`: '0.0' - '1.0'
 * - `telem.sample.requests`: '0.0' - '1.0'
 */
export function resolveTelemConfig(site?: SiteLike | null): TelemConfig {
    if (!site) return DEFAULT_TELEM_CONFIG;

    const policy = site.policy ?? {};
    const direct = (typeof site.telem === 'object' && site.telem !== null)
        ? site.telem as Record<string, unknown>
        : (typeof site.telemetry === 'object' && site.telemetry !== null)
            ? site.telemetry as Record<string, unknown>
            : undefined;

    const disabled = policy['telem.disabled'] === 'true'
        || policy['telem.enabled'] === 'false'
        || direct?.['enabled'] === false;

    if (disabled) {
        return {
            ...DEFAULT_TELEM_CONFIG,
            enabled: false,
        };
    }

    const rawLevel = (policy['telem.level'] ?? direct?.['level'] ?? 'info') as string;
    const minLevel: TelemLevel = rawLevel in LEVEL_SEVERITY ? (rawLevel as TelemLevel) : 'info';

    const parseRate = (val: unknown, fallback: number): number => {
        if (typeof val === 'number' && !Number.isNaN(val)) return Math.max(0, Math.min(1, val));
        if (typeof val === 'string') {
            const parsed = parseFloat(val);
            if (!Number.isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
        }
        return fallback;
    };

    const callRate = parseRate(policy['telem.sample.calls'] ?? direct?.['sampleCalls'], DEFAULT_TELEM_CONFIG.sampleRates.call);
    const logRate = parseRate(policy['telem.sample.logs'] ?? direct?.['sampleLogs'], DEFAULT_TELEM_CONFIG.sampleRates.log);
    const requestRate = parseRate(policy['telem.sample.requests'] ?? direct?.['sampleRequests'], DEFAULT_TELEM_CONFIG.sampleRates.request);

    return {
        enabled: true,
        minLevel,
        sampleRates: {
            error: 1.0,
            boot: 1.0,
            call: callRate,
            log: logRate,
            request: requestRate,
        },
    };
}

/**
 * Decide whether an event should be kept or dropped according to site config.
 *
 * Errors and boot events are always retained regardless of level/sampling unless explicitly disabled.
 */
export function shouldKeepEvent(
    type: TelemType,
    level: TelemLevel,
    config: TelemConfig,
    random: () => number = Math.random,
): boolean {
    if (!config.enabled) return false;

    // Errors always kept
    if (type === 'error' || level === 'error') {
        return true;
    }

    // Boot events always kept
    if (type === 'boot') {
        return true;
    }

    // Check minimum log level for log events
    if (type === 'log' && LEVEL_SEVERITY[level] < LEVEL_SEVERITY[config.minLevel]) {
        return false;
    }

    // Apply category sampling
    const rate = config.sampleRates[type] ?? 1.0;
    if (rate >= 1.0) return true;
    if (rate <= 0.0) return false;

    return random() < rate;
}
