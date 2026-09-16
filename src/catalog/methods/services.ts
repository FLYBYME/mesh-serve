/**
 * Which `kind: 'service'` parts *this node* currently has loaded, in memory only -- deliberately
 * not persisted. A database flag survives the crash that made it stale; asking this node directly
 * (routed via `ctx.call`'s `nodeID` option, resolved against the mesh's own node registry) never
 * can, since a node that's gone is simply absent from the registry rather than lying about itself.
 */

export interface RunningService {
    readonly mountKey: string;
}

const running = new Map<string, RunningService>();

export function markServiceRunning(partId: string, mountKey: string): void {
    running.set(partId, { mountKey });
}

export function getRunningService(partId: string): RunningService | undefined {
    return running.get(partId);
}

export function clearServiceRunning(partId: string): void {
    running.delete(partId);
}
