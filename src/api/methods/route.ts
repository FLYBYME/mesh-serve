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
