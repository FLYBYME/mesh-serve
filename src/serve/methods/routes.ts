/**
 * A site's description, as a route table.
 *
 * `spec/serving.md` §8, the `api` rendering. Pure: a description goes in, a matcher comes out, and a
 * test needs no server.
 */

import type { DescribedCall } from './descriptor.js';

export interface Route {
    readonly call: DescribedCall;
    readonly method: string;
    /** The path split into segments, with `:name` marking a parameter. */
    readonly segments: readonly string[];
}

export interface RouteMatch {
    readonly call: DescribedCall;
    /** Values pulled out of the path. **Verified, which is why they win over the body.** */
    readonly params: Readonly<Record<string, string>>;
}

export type RouteOutcome =
    | { readonly found: true; readonly match: RouteMatch }
    | { readonly found: false; readonly reason: 'no_route' | 'method_not_allowed' };

const split = (path: string): string[] => path.split('/').filter((s) => s !== '');

/**
 * Build the table.
 *
 * **Sorted so that literal segments beat parameters**, which is what makes `/sites/count` reachable
 * when `/sites/:id` also exists. Without it the first-declared route wins, and which one that is
 * depends on the order `defineCrud` happened to generate them in — a routing table whose behaviour
 * depends on import order is one nobody can reason about.
 */
export function routeTable(calls: readonly DescribedCall[]): Route[] {
    return calls
        .map((call) => ({ call, method: call.method.toUpperCase(), segments: split(call.path) }))
        .sort((a, b) => specificity(b.segments) - specificity(a.segments));
}

/** More literal segments, and longer, wins. */
function specificity(segments: readonly string[]): number {
    const literals = segments.filter((s) => !s.startsWith(':')).length;
    return literals * 100 + segments.length;
}

/**
 * Match a request.
 *
 * **A path that exists under another method answers `method_not_allowed`, not `no_route`.** The
 * difference is the whole value of this function to whoever is reading the error: one means *you
 * typed the wrong path*, the other means *you used the wrong verb*, and conflating them has cost
 * afternoons.
 */
export function matchRoute(table: readonly Route[], method: string, path: string): RouteOutcome {
    const wanted = split(path);
    const upper = method.toUpperCase();
    let pathExists = false;

    for (const route of table) {
        const params = matchSegments(route.segments, wanted);
        if (params === undefined) continue;

        pathExists = true;
        if (route.method !== upper) continue;

        return { found: true, match: { call: route.call, params } };
    }

    return { found: false, reason: pathExists ? 'method_not_allowed' : 'no_route' };
}

function matchSegments(
    pattern: readonly string[],
    actual: readonly string[],
): Record<string, string> | undefined {
    if (pattern.length !== actual.length) return undefined;

    const params: Record<string, string> = {};
    for (let at = 0; at < pattern.length; at += 1) {
        const expected = pattern[at];
        const got = actual[at];
        if (expected === undefined || got === undefined) return undefined;

        if (expected.startsWith(':')) {
            params[expected.slice(1)] = decodeURIComponent(got);
            continue;
        }

        if (expected !== got) return undefined;
    }

    return params;
}

/**
 * A query string carries strings, and some parameters are not strings.
 *
 * **Every generated `find` takes `query`, a record, and `limit`, a number** — and over GET both
 * arrive as text, so `?query={"userId":"x"}` failed its schema with *"Expected object, received
 * string"* and `?limit=10` with *"Expected number, received string"*. The parameters this platform
 * says nothing ever passes were, in part, unpassable.
 *
 * So a value that looks like JSON is parsed as JSON, and a value that does not is left alone.
 * **Narrow on purpose:** only `{`, `[`, and a bare number, because a hostname like `127.0.0.1` must
 * not become a number and a slug like `null` must not become nothing. Anything that fails to parse
 * stays the string it was, and the contract's own schema gets the final word either way.
 */
export function decodeQueryValue(raw: string): unknown {
    const trimmed = raw.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch {
            // Not JSON after all. The schema will say so, naming the field, which is more use than
            // a parse error naming a character offset.
            return raw;
        }
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber)) return asNumber;
    }

    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    return raw;
}

/** Every query-string parameter, decoded. */
export function decodeQuery(params: URLSearchParams): Record<string, unknown> {
    const decoded: Record<string, unknown> = {};
    for (const [key, value] of params) decoded[key] = decodeQueryValue(value);
    return decoded;
}

/**
 * One field can arrive three ways. **Route wins, then query, then body.**
 *
 * `spec/collections.md` §4. The route value is the one that was verified, so it is the one to
 * believe — and a body that disagrees with it is **an error, not a value to discard quietly**.
 * Silently preferring one of two conflicting values is how a caller ends up convinced they wrote
 * something they did not write.
 */
export function mergeInput(
    params: Readonly<Record<string, string>>,
    query: Readonly<Record<string, unknown>>,
    body: Readonly<Record<string, unknown>>,
): { readonly input: Record<string, unknown> } | { readonly conflict: string } {
    const input: Record<string, unknown> = { ...body, ...query };

    for (const [key, verified] of Object.entries(params)) {
        const supplied = input[key];
        if (supplied !== undefined && String(supplied) !== verified) {
            return {
                conflict: `"${key}" is "${verified}" in the path and "${String(supplied)}" in the `
                    + `request. The path was verified; change one of them.`,
            };
        }
        input[key] = verified;
    }

    return { input };
}
