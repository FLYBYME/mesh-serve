/**
 * Answers the gateway looked up a moment ago, reused for a few seconds.
 *
 * Every request used to ask again, one after another: which api this host is, its exposed rows,
 * whether the ticket is valid, whether the caller holds the role -- each a call over the mesh to a
 * service that reads the database. On api.surfdns.net (2026-09-29) that made every call take ~0.9 s
 * at the median and 2.5-4 s at p90, while the website answered in ~70 ms.
 *
 * What reuse costs is stated where each is used: a change (an exposure, a revoked role, a ticket
 * signed out elsewhere) takes effect within the TTL instead of at once.
 *
 * The promise is kept, not the value, so concurrent requests for the same key share one lookup.
 * A lookup that fails is forgotten at once, so a blip is not remembered for the TTL.
 *
 * With `stale`, an answer past its TTL is still given while a new lookup runs behind it, and replaced
 * when that lookup answers: no request waits for the reload. Without it, the first request after
 * the TTL paid the whole lookup -- the api's targets, every 10 s: 500-1000 ms on one request in
 * twenty-four, at 200 ms apart (the owner's timing of api.surfdns.net, 10-16).
 */
interface Entry<V> {
    value: Promise<V>;
    until: number;
    /** The lookup has answered (a stale answer is only ever one that did). */
    settled: boolean;
    /** A reload behind a stale answer is running. */
    refreshing: boolean;
}

export class Recent<V> {
    private readonly entries = new Map<string, Entry<V>>();

    constructor(
        private readonly ttlMs: number,
        /** Past this many keys the oldest are dropped: a flood of distinct tokens cannot grow it without bound. */
        private readonly maxKeys = 5000,
        private readonly now: () => number = Date.now,
        private readonly stale = false,
    ) {}

    get(key: string, load: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
        const at = this.now();
        const hit = this.entries.get(key);
        if (hit !== undefined && hit.until > at) return hit.value;

        if (this.stale && hit !== undefined && hit.settled) {
            if (!hit.refreshing) this.refresh(key, hit, load, keep);
            return hit.value;
        }

        const entry: Entry<V> = { value: load(), until: at + this.ttlMs, settled: false, refreshing: false };
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.maxKeys) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        entry.value.then(
            (v) => {
                entry.settled = true;
                if (!keep(v) && this.entries.get(key) === entry) this.entries.delete(key);
            },
            () => { if (this.entries.get(key) === entry) this.entries.delete(key); },
        );
        return entry.value;
    }

    /** A new lookup behind a stale answer: it replaces the answer when it succeeds; a failure keeps the old one for the next request to try again. */
    private refresh(key: string, hit: Entry<V>, load: () => Promise<V>, keep: (value: V) => boolean): void {
        hit.refreshing = true;
        load().then(
            (v) => {
                if (this.entries.get(key) !== hit) return;
                if (!keep(v)) {
                    this.entries.delete(key);
                    return;
                }
                hit.value = Promise.resolve(v);
                hit.until = this.now() + this.ttlMs;
                hit.refreshing = false;
            },
            () => { hit.refreshing = false; },
        );
    }

    forget(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
