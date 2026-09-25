import type { IServiceContext } from '@flybyme/mesh';

import type { NodeLinksOutput } from '../contracts/node.contract.js';

export async function nodeLinks(_params: Record<string, never>, ctx: IServiceContext): Promise<NodeLinksOutput> {
    return {
        nodeID: ctx.nodeID,
        links: [...(ctx.broker.network.peerLinks?.() ?? [])],
    };
}
