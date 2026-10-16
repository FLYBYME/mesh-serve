import crypto from 'node:crypto';

/** What of a registry node the key reads: who it is, whether it answers, and each tool's hash. */
export interface NodeTools {
    readonly nodeID: string;
    readonly available?: boolean;
    readonly services: ReadonlyArray<{ readonly tools?: Readonly<Record<string, { readonly hash?: string }>> }>;
}

/**
 * What an api's descriptor depends on, as one short key: its host, its exposure rows, and what the
 * cluster serves -- every available node's tools with their hashes (a contract or handler that
 * changes changes its hash). Equal keys, an equal descriptor.
 *
 * The descriptor was kept per target object, and the target is looked up again every 10 s: so every
 * 10 s the next call -- any call, each sets x-exposure-shape -- built it again, ~160 ms of CPU on the
 * api's node with nothing else running (the owner's profile of edge1-edge, 10-16: "that describe is
 * a killer"). The key costs a walk over the tool names, not a schema conversion of each.
 */
export function descriptorKey(host: string, rows: readonly unknown[], nodes: readonly NodeTools[]): string {
    const hash = crypto.createHash('sha256');
    hash.update(host).update('\n').update(JSON.stringify(rows)).update('\n');

    const sorted = [...nodes].sort((a, b) => a.nodeID.localeCompare(b.nodeID));
    for (const node of sorted) {
        if (node.available === false) continue;
        hash.update(node.nodeID).update('|');
        for (const service of node.services) {
            for (const [key, info] of Object.entries(service.tools ?? {})) hash.update(key).update('=').update(info.hash ?? '').update(';');
        }
        hash.update('\n');
    }

    return hash.digest('hex');
}
