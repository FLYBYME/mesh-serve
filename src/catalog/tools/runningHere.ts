import type { IServiceContext } from '@flybyme/mesh';

import type { PartRunningHereOutput } from '../contracts/supervisor.contract.js';
import { listServicesRunning } from '../methods/services.js';

/**
 * Answered from this node's own in-memory registry, deliberately -- see
 * `catalog/methods/services.ts`. A database flag survives the crash that made it stale; a node
 * that is gone is simply absent from the mesh and cannot answer at all, which is the honest
 * signal the supervisor needs.
 */
export async function runningHere(_params: Record<string, never>, ctx: IServiceContext): Promise<PartRunningHereOutput> {
    return {
        nodeID: ctx.nodeID,
        services: listServicesRunning(ctx.nodeID).map(({ partId, mountKey }) => ({ partId, domain: mountKey })),
    };
}
