/**
 * Which `kind: 'service'` parts *this node* currently has loaded, in memory only -- deliberately
 * not persisted. A database flag survives the crash that made it stale; asking this node directly
 * (routed via `ctx.call`'s `nodeID` option, resolved against the mesh's own node registry) never
 * can, since a node that's gone is simply absent from the registry rather than lying about itself.
 */

export interface RunningService {
    /** The primary domain the load registered under. */
    readonly domain: string;
    /** The module this was loaded from, so stopping it can evict that module too. */
    readonly modulePath?: string;
    /** The serve.artifact actually loaded -- absent only for core parts, which are not built artifacts. */
    readonly artifactId?: string;
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

export function markServiceRunning(nodeID: string, partId: string, domain: string, modulePath?: string, artifactId?: string): void {
    running.set(key(nodeID, partId), {
        domain,
        ...(modulePath !== undefined ? { modulePath } : {}),
        ...(artifactId !== undefined ? { artifactId } : {}),
    });
}

export function getRunningService(nodeID: string, partId: string): RunningService | undefined {
    return running.get(key(nodeID, partId));
}

export function clearServiceRunning(nodeID: string, partId: string): void {
    running.delete(key(nodeID, partId));
}

/**
 * Everything one node is running, for `serve.part.runningHere`.
 *
 * Core parts are excluded: they are keyed `core:<name>` and are not `serve.part` rows, so they
 * have no desired state for the supervisor to compare against. Only catalog-managed services are
 * its business.
 */
export function listServicesRunning(nodeID: string): { partId: string; domain: string; artifactId?: string }[] {
    const prefix = `${nodeID}\u0000`;
    const found: { partId: string; domain: string; artifactId?: string }[] = [];

    for (const [entryKey, service] of running) {
        if (!entryKey.startsWith(prefix)) continue;
        const partId = entryKey.slice(prefix.length);
        if (partId.startsWith('core:')) continue;
        found.push({
            partId,
            domain: service.domain,
            ...(service.artifactId !== undefined ? { artifactId: service.artifactId } : {}),
        });
    }

    return found;
}
