import { randomBytes } from 'node:crypto';

/**
 * W3C trace context (https://www.w3.org/TR/trace-context/), the `traceparent` header only:
 * `00-<32 hex trace id>-<16 hex parent span id>-<2 hex flags>`. An api request that brings one runs
 * in that trace; one that does not starts its own. Either way the response names it, so a caller
 * (or an operator holding a failed response) can find every call it caused.
 */
export interface Trace {
    readonly traceId: string;
    /** The caller's own span, when it said: the parent of everything this request does. */
    readonly parentSpanId?: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE = '0'.repeat(32);
const ALL_ZERO_SPAN = '0'.repeat(16);

/** The trace a request asked for; undefined for no header, or one the spec says to ignore. */
export function readTraceparent(header: string | string[] | undefined): Trace | undefined {
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) return undefined;

    const match = TRACEPARENT.exec(value.trim().toLowerCase());
    if (match === null) return undefined;

    const [, traceId, parentSpanId] = match;
    if (traceId === undefined || parentSpanId === undefined) return undefined;
    if (traceId === ALL_ZERO_TRACE || parentSpanId === ALL_ZERO_SPAN) return undefined;

    return { traceId, parentSpanId };
}

export function newTraceId(): string {
    return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
    return randomBytes(8).toString('hex');
}

/** This request's own span in that trace, sampled. */
export function formatTraceparent(traceId: string, spanId: string): string {
    return `00-${traceId}-${spanId}-01`;
}
