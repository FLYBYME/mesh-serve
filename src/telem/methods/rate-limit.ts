/**
 * In-memory rate limiting to bound anonymous calls on the public ingest contract.
 *
 * Sliding-window rate limiter per session and per site host.
 */

export interface RateLimitOptions {
    /** Max batches per minute per session ID. Default 120. */
    readonly maxBatchesPerSessionPerMinute?: number;
    /** Max events per minute per session ID. Default 1000. */
    readonly maxEventsPerSessionPerMinute?: number;
    /** Max batches per minute per site host. Default 2000. */
    readonly maxBatchesPerHostPerMinute?: number;
}

interface WindowBucket {
    windowStart: number;
    batches: number;
    events: number;
}

export class TelemRateLimiter {
    private readonly sessionLimits = new Map<string, WindowBucket>();
    private readonly hostLimits = new Map<string, WindowBucket>();
    private readonly windowMs = 60_000; // 1 minute
    private lastPrune = Date.now();

    private readonly maxBatchesSession: number;
    private readonly maxEventsSession: number;
    private readonly maxBatchesHost: number;

    constructor(options: RateLimitOptions = {}) {
        this.maxBatchesSession = options.maxBatchesPerSessionPerMinute ?? 120;
        this.maxEventsSession = options.maxEventsPerSessionPerMinute ?? 1000;
        this.maxBatchesHost = options.maxBatchesPerHostPerMinute ?? 2000;
    }

    /**
     * Check and record an incoming batch. Returns true if allowed, false if rate limited.
     */
    public allow(sessionId: string, host: string | undefined, eventCount: number): boolean {
        const now = Date.now();
        this.maybePrune(now);

        // Check session limit
        const sessionBucket = this.getOrCreateBucket(this.sessionLimits, sessionId, now);
        if (sessionBucket.batches + 1 > this.maxBatchesSession || sessionBucket.events + eventCount > this.maxEventsSession) {
            return false;
        }

        // Check host limit (if host provided)
        if (host !== undefined && host !== '') {
            const hostBucket = this.getOrCreateBucket(this.hostLimits, host, now);
            if (hostBucket.batches + 1 > this.maxBatchesHost) {
                return false;
            }
            hostBucket.batches += 1;
            hostBucket.events += eventCount;
        }

        sessionBucket.batches += 1;
        sessionBucket.events += eventCount;
        return true;
    }

    private getOrCreateBucket(map: Map<string, WindowBucket>, key: string, now: number): WindowBucket {
        let bucket = map.get(key);
        if (bucket === undefined || now - bucket.windowStart >= this.windowMs) {
            bucket = { windowStart: now, batches: 0, events: 0 };
            map.set(key, bucket);
        }
        return bucket;
    }

    private maybePrune(now: number): void {
        if (now - this.lastPrune < 60_000) return;
        this.lastPrune = now;

        for (const [key, bucket] of this.sessionLimits.entries()) {
            if (now - bucket.windowStart >= this.windowMs) {
                this.sessionLimits.delete(key);
            }
        }
        for (const [key, bucket] of this.hostLimits.entries()) {
            if (now - bucket.windowStart >= this.windowMs) {
                this.hostLimits.delete(key);
            }
        }
    }
}
