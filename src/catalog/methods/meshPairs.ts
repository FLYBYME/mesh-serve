/**
 * The pairs of a full mesh that no report shows linked. A pair counts as linked if either side
 * reports it: a link is one socket, and the two ends can disagree for an instant while it opens or
 * closes. Only nodes that answered are compared -- an unanswered node's links are unknown, not
 * missing.
 */
export function missingPairs(reports: readonly { nodeID: string; links: readonly string[] }[]): { a: string; b: string }[] {
    const key = (x: string, y: string): string => [x, y].sort().join('\u0000');
    const linked = new Set<string>();
    for (const report of reports) {
        for (const peer of report.links) linked.add(key(report.nodeID, peer));
    }

    const ids = reports.map((report) => report.nodeID).sort();
    const missing: { a: string; b: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i];
            const b = ids[j];
            if (a !== undefined && b !== undefined && !linked.has(key(a, b))) missing.push({ a, b });
        }
    }
    return missing;
}
