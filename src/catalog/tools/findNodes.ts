import type { IServiceContext } from '@flybyme/mesh';

import type { NodeFindInput, NodeFindOutput } from '../contracts/node.contract.js';
import { nodesForLabel } from '../methods/resolveNode.js';

export async function findNodes(input: NodeFindInput, ctx: IServiceContext): Promise<NodeFindOutput> {
    const nodes = input.label !== undefined
        ? nodesForLabel(ctx.broker.registry, input.label)
        : ctx.broker.registry.getAvailableNodes();

    return nodes.map((node) => ({
        nodeID: node.nodeID,
        hostname: node.hostname,
        labels: (node.metadata ?? {}) as Record<string, string>,
        available: node.available,
    }));
}
