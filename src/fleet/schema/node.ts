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
    /** Which manifest entries this node is assigned to run directly (desired state). */
    services: z.array(z.string()).default([]),
    /**
     * Groups this node belongs to, **by name and not expanded**.
     *
     * Storing the reference is the whole decision. Expanding a group at assign time and keeping the
     * result would mean every edit to a group needs a manual re-assign of every node in it, and the
     * nodes nobody remembers go on running yesterday's set — the same failure that leaves a site
     * serving a part from two days ago because nobody re-composed it.
     *
     * So a group edit rolls: `node.reconcile` recomputes from the group and applies the difference.
     *
     * A node holds groups **and** `services`, and the desired set is the union of both. One machine
     * that also runs a builder does not need a group of its own.
     */
    groups: z.array(z.string()).default([]),
}).strict();

export type NodeRecord = z.infer<typeof NodeSchema>;

/**
 * A named set of services, so seven machines are not configured one service at a time.
 *
 * Deliberately thin: a name and a list. Everything that makes a group *useful* — that editing one
 * changes every node in it — is behaviour in `reconcile`, not a field here.
 */
/**
 * Services every node runs and no assignment can switch.
 *
 * **A node that can be told to switch off the service that receives its orders cannot be told
 * anything again.** `fleet` answers *what should I be running*; `identity` and `api` are how a
 * person authenticates to give the order at all. A node that went dark because somebody unticked
 * one of these would need a drive to a datacentre.
 *
 * So the runner registers them directly and the Supervisor never owns them — which means
 * `supervisor.service_start` does not know their names, and assigning one used to answer
 * *"Unknown service: api"* and abandon the whole reconcile.
 *
 * **One list, two readers**: `bin/node.mjs` registers exactly these directly, and `reconcileNode`
 * treats them as permanently satisfied. Two copies of this list would disagree on the day somebody
 * adds a fourth, and the symptom would be a node that cannot converge.
 */
export const CORE_SERVICES: readonly string[] = ['api', 'identity', 'fleet', 'supervisor'];

export const GroupSchema = z.object({
    name: z.string().min(1),
    services: z.array(z.string()).default([]),
    description: z.string().optional(),
}).strict();

export type GroupRecord = z.infer<typeof GroupSchema>;

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
    provisionedServices: z.array(z.string()).optional(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export const NodeStatusReportSchema = z.object({
    hostname: z.string(),
    nodeID: z.string().optional(),
    connected: z.boolean(),
    peers: z.array(PeerInfoSchema),
    desiredServices: z.array(z.string()),
    runningServices: z.array(z.string()),
    provisionedServices: z.array(z.string()).default([]),
    services: z.array(ServiceRunStatusSchema).optional(),
    nodes: z.array(NodeSummarySchema).optional(),
    error: z.string().optional(),
});
export type NodeStatusReport = z.infer<typeof NodeStatusReportSchema>;

export const NodeProvisionInputSchema = z.object({
    /** The node's stable identity: its hostname. */
    hostname: z.string().min(1),
    /** Name of the service entry in the Supervisor manifest. */
    name: z.string().min(1),
    /** Git repository URL to clone or pull. */
    repository: z.string().min(1),
    /** Pinned commit SHA or tag. Mutable branch names (e.g. main) are refused. */
    ref: z.string().min(1),
    /** Optional path to the compiled service entry module relative to repo root (or absolute). */
    path: z.string().optional(),
    /** Optional dependencies that must be running before this service starts. */
    dependsOn: z.array(z.string()).default([]),
    /** Optional mountKey alias for running isolated instances. */
    mountKey: z.string().optional(),
}).strict();
export type NodeProvisionInput = z.infer<typeof NodeProvisionInputSchema>;

export const NodeProvisionOutcomeSchema = z.object({
    hostname: z.string(),
    name: z.string(),
    repository: z.string(),
    ref: z.string(),
    applied: z.boolean(),
    noop: z.boolean(),
    message: z.string(),
    path: z.string().optional(),
    error: z.string().optional(),
}).strict();
export type NodeProvisionOutcome = z.infer<typeof NodeProvisionOutcomeSchema>;
