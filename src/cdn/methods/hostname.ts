/**
 * Which site a request is for, and whether this node may answer it.
 *
 * Both questions are about the **origin**, which is the isolation boundary: everything a browser
 * isolates — storage, cookies, `localStorage`, the whole same-origin policy — is scoped to it. So
 * these are serving-layer invariants, checked on the path that serves rather than assumed by the
 * path that configures.
 */

import type { Site } from '../schema/site.js';

/**
 * The hostname a lookup is keyed by.
 *
 * Lowercased, port stripped, trailing dot removed: `Example.com`, `example.com:443` and
 * `example.com.` are one site. Without this a site could be *found* under one spelling and missed
 * under another, which is a 404 that comes and goes with how a link was typed.
 *
 * `localhost` and `127.0.0.1` stay different, and that is deliberate — it is what lets one node
 * serve two sites during development.
 */
export function normalizeHostname(host: string): string {
    const withoutPort = host.trim().toLowerCase().replace(/:\d+$/, '');
    return withoutPort.endsWith('.') ? withoutPort.slice(0, -1) : withoutPort;
}

/**
 * Which hostname a request names.
 *
 * `x-forwarded-host` can carry a list when a request passed through more than one proxy. The
 * **first** entry is the client's original host and the rest are intermediaries, so anything else
 * would serve the site belonging to a proxy rather than to the caller.
 *
 * **Trust is a deployment decision, never a guess.** Behind the surfdns proxy the header is
 * authoritative, because the proxy rewrote `Host` to reach this node. A node reachable *directly*
 * must not trust it: a caller could then name any hostname and be served whatever it serves. That is
 * public content either way, so it is not a disclosure — but it makes the origin a caller's choice,
 * and the origin is the isolation boundary.
 */
export function hostOf(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    trustForwarded: boolean,
): string {
    if (trustForwarded) {
        const forwarded = headers['x-forwarded-host'];
        const value = Array.isArray(forwarded) ? forwarded[0] : forwarded as string | undefined;
        const first = value?.split(',')[0]?.trim();
        if (first !== undefined && first !== '') return normalizeHostname(first);
    }
    return normalizeHostname((headers['host'] as string | undefined) ?? '');
}

/**
 * Never serve two tenants from one hostname.
 *
 * The check looks trivial, and that is the point. It exists so that a future change making hostname
 * resolution cleverer — a wildcard, a fallback, an alias table — cannot quietly produce a site whose
 * tenant is not the one that hostname belongs to without this failing.
 */
export class TenantMismatch extends Error {
    override readonly name = 'TenantMismatch';

    constructor(readonly host: string, readonly expected: string, readonly actual: string) {
        super(
            `${host} belongs to tenant ${expected} but resolved to a site owned by ${actual}. ` +
            `The origin is the isolation boundary, so this is refused rather than served.`,
        );
    }
}

/**
 * @param expected which tenant this node is dedicated to, or `undefined` on a shared node.
 */
export function assertTenant(host: string, site: Site, expected: string | undefined): void {
    if (expected === undefined) return;
    if (site.tenantId !== expected) {
        throw new TenantMismatch(normalizeHostname(host), expected, site.tenantId);
    }
}
