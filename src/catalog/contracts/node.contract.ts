import { defineContract, z } from '@flybyme/mesh';

/**
 * Cluster topology, not tenant data -- unscoped, like serve.part's own runningHere/reconcile.
 * `serve.node.find` is what an operator checks before pinning a service to a label
 * (serve.part's own nodeSelector field): "is anything actually online under role=dns right now."
 */
export const nodeFindInputSchema = z.object({
    label: z.string().optional().describe('"key=value" -- only nodes advertising that label (see mesh-serve start --labels). Omitted lists every available node'),
});

export const nodeFindOutputSchema = z.array(z.object({
    nodeID: z.string(),
    hostname: z.string().optional(),
    labels: z.record(z.string(), z.string()).describe('What this node was started with, e.g. { role: "dns", region: "bhs" } -- set via mesh-serve start --labels'),
    available: z.boolean().optional(),
})).describe('Every node currently visible in this cluster\'s registry');

export const nodeFindContract = defineContract({
    domain: 'serve.node',
    action: 'find',
    description: 'List the nodes visible in this cluster, and the labels each advertises.',
    inputSchema: nodeFindInputSchema,
    outputSchema: nodeFindOutputSchema,
    rest: { method: 'GET', path: '/nodes' },
    visibility: 'public',
    filePath: 'src/catalog/tools/findNodes.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => (o.length === 0 ? 'no nodes' : o.map((n) => `${n.nodeID} ${JSON.stringify(n.labels)}`).join('\n')),
});

export type NodeFindInput = z.infer<typeof nodeFindContract.inputSchema>;
export type NodeFindOutput = z.infer<typeof nodeFindContract.outputSchema>;
