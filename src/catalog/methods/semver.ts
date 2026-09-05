/**
 * Just enough semver to resolve a range against published versions.
 *
 * Written rather than installed, for the reason the resolver exists at all: **this is the hardest
 * logic in the system and it should be the most testable thing in it.** Pure functions over strings,
 * no clock, no database, no network — a resolution can be checked in a unit test with nothing
 * running, which is what makes it safe to be load-bearing.
 *
 * The subset is the one a catalog actually uses: `*`, an exact version, `^`, `~`, and `>=`. Anything
 * else is refused rather than approximated, because a range nobody implemented that silently matches
 * *nothing* looks exactly like a part that was never published.
 */

export interface Version {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** `1.0.0-beta.1` → `['beta', 1]`. Empty for a release. */
    readonly prerelease: readonly (string | number)[];
}

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `undefined` rather than a throw: an unparseable version in the catalog should not fail a query. */
export function parse(text: string): Version | undefined {
    const match = PATTERN.exec(text.trim());
    if (match === null) return undefined;

    const prerelease = match[4] === undefined
        ? []
        : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));

    return {
        major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease,
    };
}

/** Negative when `a` is older. Total, so it can sort. */
export function compare(a: Version, b: Version): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;

    // A release outranks any prerelease of the same version: 1.0.0 is newer than 1.0.0-beta.
    if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
    if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;

    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
        const left = a.prerelease[i];
        const right = b.prerelease[i];
        if (left === undefined) return -1;
        if (right === undefined) return 1;
        if (left === right) continue;

        // Numeric identifiers rank below alphanumeric ones, and compare numerically among themselves.
        if (typeof left === 'number' && typeof right === 'number') return left - right;
        if (typeof left === 'number') return -1;
        if (typeof right === 'number') return 1;
        return left < right ? -1 : 1;
    }

    return 0;
}

/**
 * A range, as the two bounds it means.
 *
 * `undefined` for an unsupported range — the caller reports it as unsatisfiable *naming the range*,
 * which is the difference between "nobody published that" and "nobody implemented that".
 */
interface Bounds {
    readonly min: Version;
    /** Exclusive. Absent means unbounded above. */
    readonly below?: Version;
    /** Only an exact range matches a prerelease, so `1.0.0-beta` is never picked up by `^1.0`. */
    readonly exact: boolean;
}

const zero = (major: number, minor = 0, patch = 0): Version =>
    ({ major, minor, patch, prerelease: [] });

/**
 * The partial forms matter: `^0.2` has no patch, and it is what everything here actually writes.
 */
function parsePartial(text: string): Version | undefined {
    const parts = text.trim().split('.');
    if (parts.length === 3) return parse(text);
    if (parts.length > 3 || parts.length === 0) return undefined;
    if (!parts.every((p) => /^\d+$/.test(p))) return undefined;
    return zero(Number(parts[0]), parts[1] === undefined ? 0 : Number(parts[1]));
}

export function boundsOf(range: string): Bounds | undefined {
    const text = range.trim();

    if (text === '*' || text === '') return { min: zero(0), exact: false };

    if (text.startsWith('^')) {
        const base = parsePartial(text.slice(1));
        if (base === undefined) return undefined;

        // **The 0.x rule, and it is the one that matters here.** `^1.2` allows anything below 2.0,
        // but `^0.2` allows only below 0.3 — a leading zero means the API is not stable and a minor
        // bump may break. mesh-web is 0.2.0, so this is the live case, not a corner one.
        const below = base.major > 0
            ? zero(base.major + 1)
            : base.minor > 0
                ? zero(0, base.minor + 1)
                : zero(0, 0, base.patch + 1);

        return { min: base, below, exact: false };
    }

    if (text.startsWith('~')) {
        const base = parsePartial(text.slice(1));
        if (base === undefined) return undefined;
        return { min: base, below: zero(base.major, base.minor + 1), exact: false };
    }

    if (text.startsWith('>=')) {
        const base = parsePartial(text.slice(2));
        return base === undefined ? undefined : { min: base, exact: false };
    }

    const exact = parse(text);
    return exact === undefined ? undefined : { min: exact, below: undefined, exact: true };
}

export function satisfies(version: string, range: string): boolean {
    const found = parse(version);
    const bounds = boundsOf(range);
    if (found === undefined || bounds === undefined) return false;

    if (bounds.exact) return compare(found, bounds.min) === 0;

    // A prerelease is opt-in. `^1.0` must not quietly resolve to `1.1.0-rc.1`, or publishing a
    // release candidate would ship it to every site tracking the range.
    if (found.prerelease.length > 0) return false;

    if (compare(found, bounds.min) < 0) return false;
    return bounds.below === undefined || compare(found, bounds.below) < 0;
}

/**
 * The newest published version satisfying a range, or `undefined`.
 *
 * Newest, not first: a catalog query returns rows in whatever order the database chose, and
 * resolution must not depend on that.
 */
export function highest(versions: readonly string[], range: string): string | undefined {
    let best: { text: string; parsed: Version } | undefined;

    for (const text of versions) {
        if (!satisfies(text, range)) continue;
        const parsed = parse(text);
        if (parsed === undefined) continue;
        if (best === undefined || compare(parsed, best.parsed) > 0) best = { text, parsed };
    }

    return best?.text;
}
