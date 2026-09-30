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
 */
export class Recent<V> {
    private readonly entries = new Map<string, { readonly value: Promise<V>; readonly until: number }>();

    constructor(
        private readonly ttlMs: number,
        /** Past this many keys the oldest are dropped: a flood of distinct tokens cannot grow it without bound. */
        private readonly maxKeys = 5000,
        private readonly now: () => number = Date.now,
    ) {}

    get(key: string, load: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
        const at = this.now();
        const hit = this.entries.get(key);
        if (hit !== undefined && hit.until > at) return hit.value;

        const value = load();
        this.entries.delete(key);
        this.entries.set(key, { value, until: at + this.ttlMs });
        while (this.entries.size > this.maxKeys) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        value.then(
            (v) => { if (!keep(v) && this.entries.get(key)?.value === value) this.entries.delete(key); },
            () => { if (this.entries.get(key)?.value === value) this.entries.delete(key); },
        );
        return value;
    }

    forget(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
