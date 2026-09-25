/**
 * Matches a REST path pattern (":param" segments) against an actual request path, extracting
 * params on a match. Segment-count mismatch or a literal-segment mismatch both fail outright --
 * there is no partial or prefix matching.
 */
export function matchPath(pattern: string, actual: string): Record<string, string> | undefined {
    const patternParts = pattern.split('/').filter((part) => part.length > 0);
    const actualParts = actual.split('/').filter((part) => part.length > 0);

    if (patternParts.length !== actualParts.length) {
        return undefined;
    }

    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i]!;
        const actualPart = actualParts[i]!;
        if (patternPart.startsWith(':')) {
            params[patternPart.slice(1)] = decodeURIComponent(actualPart);
        } else if (patternPart !== actualPart) {
            return undefined;
        }
    }
    return params;
}

/**
 * How specific a matching pattern is: one point per literal segment. When several exposed
 * patterns match a request, the most specific wins -- `/repos/one` over `/repos/:id` -- whatever
 * order their rows happen to be in. Without this the first row won, and `serve.repo.find_one`
 * (GET /repos/one) was answered by a `get` that read "one" as an id.
 */
export function specificity(pattern: string): number {
    return pattern.split('/').filter((part) => part.length > 0 && !part.startsWith(':')).length;
}

/**
 * The route's identity with parameter names erased: `GET /repos/:id` and `GET /repos/:repoId`
 * are the same route. Two exposed contracts with one shape cannot both be reached -- whichever
 * matched first answered every request for both.
 */
export function routeShape(method: string, pattern: string): string {
    const segments = pattern.split('/').filter((part) => part.length > 0).map((part) => (part.startsWith(':') ? ':' : part));
    return `${method.toUpperCase()} /${segments.join('/')}`;
}
