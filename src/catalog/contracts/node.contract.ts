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

const peerLinkSchema = z.object({
    nodeID: z.string().describe('The peer at the other end'),
    dialedBy: z.enum(['self', 'remote']).describe('Which end opened the link'),
    openedAt: z.number().describe('When the link opened (epoch ms)'),
    lastMessageAt: z.number().describe('When a frame last arrived on it (epoch ms)'),
});

export const nodeLinksOutputSchema = z.object({
    nodeID: z.string(),
    links: z.array(peerLinkSchema),
}).describe('The direct mesh links one node holds right now');

/**
 * One node's own view of its links, answered by that node -- called with `{ nodeID }` to ask a
 * specific one, which is how `serve.node.mesh` asks them all.
 */
export const nodeLinksContract = defineContract({
    domain: 'serve.node',
    action: 'links',
    description: 'The direct mesh links this node holds right now.',
    inputSchema: z.object({}),
    outputSchema: nodeLinksOutputSchema,
    rest: { method: 'GET', path: '/nodes/links' },
    visibility: 'public',
    filePath: 'src/catalog/tools/nodeLinks.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.nodeID}: ${o.links.length === 0 ? 'no links' : o.links.map((l) => l.nodeID).join(', ')}`,
});

export type NodeLinksOutput = z.infer<typeof nodeLinksContract.outputSchema>;

export const nodeMeshOutputSchema = z.object({
    nodes: z.array(z.object({
        nodeID: z.string(),
        links: z.array(z.string()).describe('Peers this node reports a direct link to'),
        error: z.string().optional().describe('Why this node could not be asked'),
    })),
    missing: z.array(z.object({
        a: z.string(),
        b: z.string(),
    })).describe('Pairs of answering nodes with no direct link between them, as either side sees it'),
    complete: z.boolean().describe('Every node answered and every pair is linked'),
}).describe('Every node\'s links, and which pairs of the full mesh are missing');

/**
 * The whole mesh at a glance: asks every available node for its own links and lists the pairs that
 * are not linked. The cluster is meant to be a full mesh (every node bootstraps to every other), so
 * a missing pair is a fault -- this is what used to take `ss` on four boxes over SSH.
 */
export const nodeMeshContract = defineContract({
    domain: 'serve.node',
    action: 'mesh',
    description: 'Every node\'s direct links, and the pairs of the full mesh that are missing.',
    inputSchema: z.object({}),
    outputSchema: nodeMeshOutputSchema,
    rest: { method: 'GET', path: '/nodes/mesh' },
    visibility: 'public',
    filePath: 'src/catalog/tools/nodeMesh.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => [
        ...o.nodes.map((n) => `${n.nodeID}: ${n.error !== undefined ? `unreachable (${n.error})` : n.links.join(', ') || 'no links'}`),
        o.complete ? 'full mesh' : `missing: ${o.missing.map((m) => `${m.a}<->${m.b}`).join(', ') || 'nodes did not answer'}`,
    ].join('\n'),
});

export type NodeMeshOutput = z.infer<typeof nodeMeshContract.outputSchema>;
