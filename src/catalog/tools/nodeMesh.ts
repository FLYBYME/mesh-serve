import type { IServiceContext } from '@flybyme/mesh';

import type { NodeMeshOutput } from '../contracts/node.contract.js';
import { missingPairs } from '../methods/meshPairs.js';

/** Long enough for a healthy node over WireGuard, short enough that one dead node does not stall the answer. */
const ASK_TIMEOUT_MS = 5_000;

export async function nodeMesh(_params: Record<string, never>, ctx: IServiceContext): Promise<NodeMeshOutput> {
    const nodeIDs = ctx.broker.registry.getAvailableNodes().map((node) => node.nodeID).sort();

    const nodes = await Promise.all(nodeIDs.map(async (nodeID) => {
        try {
            // Pinned to that node: the answer has to be its own view, not whichever node the
            // balancer would pick.
            const report = await ctx.call('serve.node.links', {}, { nodeID, timeout: ASK_TIMEOUT_MS });
            return { nodeID, links: report.links.map((link) => link.nodeID).sort() };
        } catch (err) {
            return { nodeID, links: [], error: err instanceof Error ? err.message : String(err) };
        }
    }));

    const answered = nodes.filter((node) => node.error === undefined);
    const missing = missingPairs(answered);
    return { nodes, missing, complete: missing.length === 0 && answered.length === nodes.length };
}
