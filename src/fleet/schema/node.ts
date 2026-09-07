import { z } from 'zod';

/**
 * Desired state of a node: its assigned services.
 *
 * M2 / Fleet: "Identity is the hostname. Not the per-process nodeID the mesh mints...
 * Desired state only. The row holds the assignment: which manifest entries this
 * node should be running. Observed state is Registry presence."
 *
 * Deliberately no `lastSeen`, no `healthy`, no `status`, no heartbeat columns.
 * See cdn/schema/edge.ts: a second heartbeat beside Registry produces two sources
 * of truth that disagree during partitions.
 */
export const NodeSchema = z.object({
    /** The node's stable identity: its hostname. */
    hostname: z.string().min(1),
    /** Which manifest entries this node is assigned to run (desired state). */
    services: z.array(z.string()).default([]),
}).strict();

export type NodeRecord = z.infer<typeof NodeSchema>;

export const ServiceRunStatusSchema = z.object({
    name: z.string(),
    domain: z.string().optional(),
    status: z.enum(['stopped', 'running', 'error']),
    dependsOn: z.array(z.string()).default([]),
    error: z.string().optional(),
});
export type ServiceRunStatus = z.infer<typeof ServiceRunStatusSchema>;

export const PeerInfoSchema = z.object({
    nodeID: z.string(),
    hostname: z.string().optional(),
    addresses: z.array(z.string()).optional(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const NodeSummarySchema = z.object({
    hostname: z.string(),
    nodeID: z.string().optional(),
    connected: z.boolean(),
    desiredServices: z.array(z.string()),
    runningServices: z.array(z.string()),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export const NodeStatusReportSchema = z.object({
    hostname: z.string(),
    nodeID: z.string().optional(),
    connected: z.boolean(),
    peers: z.array(PeerInfoSchema),
    desiredServices: z.array(z.string()),
    runningServices: z.array(z.string()),
    services: z.array(ServiceRunStatusSchema).optional(),
    nodes: z.array(NodeSummarySchema).optional(),
    error: z.string().optional(),
});
export type NodeStatusReport = z.infer<typeof NodeStatusReportSchema>;
