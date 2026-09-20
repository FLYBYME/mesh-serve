/**
 * Which `kind: 'service'` parts *this node* currently has loaded, in memory only -- deliberately
 * not persisted. A database flag survives the crash that made it stale; asking this node directly
 * (routed via `ctx.call`'s `nodeID` option, resolved against the mesh's own node registry) never
 * can, since a node that's gone is simply absent from the registry rather than lying about itself.
 */

export interface RunningService {
    readonly mountKey: string;
    /** The module this was loaded from, so stopping it can evict that module too. */
    readonly modulePath?: string;
}

const running = new Map<string, RunningService>();

/**
 * Keyed by node as well as part.
 *
 * "This node" is one process in production, so a bare partId key was right in practice and wrong
 * in principle -- and the principle bites the moment a single process hosts two brokers, which is
 * exactly what a two-node test is. Without the nodeID, the second node is told a part is already
 * running because the *first* node loaded it.
 */
function key(nodeID: string, partId: string): string {
    return `${nodeID}\u0000${partId}`;
}

export function markServiceRunning(nodeID: string, partId: string, mountKey: string, modulePath?: string): void {
    running.set(key(nodeID, partId), modulePath === undefined ? { mountKey } : { mountKey, modulePath });
}

export function getRunningService(nodeID: string, partId: string): RunningService | undefined {
    return running.get(key(nodeID, partId));
}

export function clearServiceRunning(nodeID: string, partId: string): void {
    running.delete(key(nodeID, partId));
}
