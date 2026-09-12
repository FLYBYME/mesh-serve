/**
 * Which hostname a connection names, and what it is keyed by.
 *
 * `spec/serving.md` §3. Both questions are about the **origin**, which is the isolation boundary:
 * everything a browser isolates — storage, cookies, the whole same-origin policy — is scoped to it.
 * So these are serving-layer rules, checked on the path that serves rather than assumed by the path
 * that configures.
 *
 * Pure functions over strings. No broker, no database, and a test needs neither.
 */

/**
 * The hostname a lookup is keyed by.
 *
 * Lowercased, port stripped, trailing dot removed: `Example.com`, `example.com:443` and
 * `example.com.` are **one site**. Without this a site is findable under one spelling and missing
 * under another, which is a 404 that comes and goes with how a link was typed.
 *
 * `localhost` and `127.0.0.1` stay different, deliberately — it is what lets one node serve two
 * sites in development, and it is how the control site is addressed.
 */
export function normalizeHostname(host: string): string {
    const withoutPort = host.trim().toLowerCase().replace(/:\d+$/, '');
    return withoutPort.endsWith('.') ? withoutPort.slice(0, -1) : withoutPort;
}

/**
 * Which hostname a request names.
 *
 * `x-forwarded-host` can carry a list when a request passed through more than one proxy. **The first
 * entry is the client's original host** and the rest are intermediaries, so anything else serves the
 * site belonging to a proxy rather than to the caller.
 *
 * **Trust is a deployment decision, never a guess.** Behind a trusted proxy the header is
 * authoritative, because the proxy rewrote `Host` to reach this node. A node reachable directly must
 * not trust it: a caller could then name any hostname and be served whatever it serves. That is
 * public content either way, so it is not a disclosure — but it makes the origin a caller's choice,
 * and the origin is the isolation boundary.
 */
export function hostOf(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    trustForwarded: boolean,
): string {
    if (trustForwarded) {
        const forwarded = headers['x-forwarded-host'];
        const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        if (typeof first === 'string' && first !== '') {
            const original = first.split(',')[0];
            if (original !== undefined && original.trim() !== '') return normalizeHostname(original);
        }
    }

    const host = headers['host'];
    const value = Array.isArray(host) ? host[0] : host;
    return normalizeHostname(typeof value === 'string' ? value : '');
}
