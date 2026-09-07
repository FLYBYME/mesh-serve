/**
 * Desired minus observed, applied.
 *
 * One function, because there are now three ways for a node's desired set to change — it was
 * assigned directly, a group it belongs to was edited, or it just reconnected — and three copies of
 * "work out the difference and call the supervisor" is three chances for them to disagree about
 * what a difference is.
 *
 * It is **idempotent**: reconciling a node that is already correct starts nothing and stops nothing.
 * That is what makes it safe to call on a timer, on an event, or by hand when something looks wrong.
 */

import type { IServiceContext } from '@flybyme/mesh';

import type { GroupRecord, NodeRecord } from '../schema/node.js';

export interface ReconcileOutcome {
    readonly hostname: string;
    /** The union of the node's own services and every group it belongs to. */
    readonly services: string[];
    /** False when the node is not currently on the mesh. Its row is still updated. */
    readonly applied: boolean;
    readonly started?: string[];
    readonly stopped?: string[];
    readonly error?: string;
}

interface RegistryNode {
    nodeID: string;
    hostname?: string;
    available?: boolean;
}

/**
 * What a node should be running: its own services, plus every group it belongs to.
 *
 * A group named on a node but absent from the collection contributes nothing rather than throwing.
 * A group can be deleted while nodes still reference it, and the useful behaviour is that those
 * nodes lose the group's services — not that reconciling them fails and leaves them frozen on
 * whatever they happened to be running.
 */
export function resolveDesired(node: NodeRecord, groups: readonly GroupRecord[]): string[] {
    const byName = new Map(groups.map((g) => [g.name, g]));
    const out = new Set<string>(node.services ?? []);

    for (const name of node.groups ?? []) {
        for (const service of byName.get(name)?.services ?? []) out.add(service);
    }

    // Sorted, so a stored row and a recomputed one compare equal regardless of the order somebody
    // happened to type the groups in.
    return [...out].sort();
}

/** Every node whose desired set could have changed because this group did. */
export async function nodesInGroup(
    ctx: IServiceContext,
    groupName: string,
): Promise<(NodeRecord & { id: string })[]> {
    const all = await ctx.call('node.find', { query: {} }) as (NodeRecord & { id: string })[];
    return (all ?? []).filter((n) => (n.groups ?? []).includes(groupName));
}

/**
 * Bring one node's running services in line with what it should be running.
 *
 * **Stops before starts**, deliberately. A node being moved from one service to another is usually
 * being moved because the first one should not be there — and on `surf`, which has 981MB of RAM,
 * starting the new one first can mean neither fits.
 */
export async function reconcileNode(
    ctx: IServiceContext,
    node: NodeRecord,
    groups: readonly GroupRecord[],
): Promise<ReconcileOutcome> {
    const services = resolveDesired(node, groups);
    const broker = ctx.broker as unknown as {
        nodeID: string;
        call(tool: string, input: unknown, options?: { nodeID: string }): Promise<unknown>;
        getProvider?<T>(name: string): T;
        registry?: { getNodes(): RegistryNode[] };
    };

    const registry = broker.getProvider?.<{ getNodes(): RegistryNode[] }>('registry') ?? broker.registry;
    const live = (registry?.getNodes?.() ?? []).find(
        (n) => (n.available ?? true) && n.hostname === node.hostname,
    );

    // Offline is not a failure. The row is the desired state and `node.hello` hands it back when the
    // machine returns, so a node that was down during a group edit converges by reconnecting rather
    // than by somebody remembering it was down.
    if (live === undefined) return { hostname: node.hostname, services, applied: false };

    const target = live.nodeID === broker.nodeID ? undefined : { nodeID: live.nodeID };

    try {
        const status = await broker.call('supervisor.service_status', {}, target) as {
            services?: { name: string; status: string }[];
        };

        const running = new Set(
            (status.services ?? []).filter((s) => s.status === 'running').map((s) => s.name),
        );
        const wanted = new Set(services);

        const toStop = [...running].filter((s) => !wanted.has(s));
        const toStart = services.filter((s) => !running.has(s));

        for (const name of toStop) {
            await broker.call('supervisor.service_stop', { name, cascade: true }, target);
        }
        for (const name of toStart) {
            await broker.call('supervisor.service_start', { name }, target);
        }

        return { hostname: node.hostname, services, applied: true, started: toStart, stopped: toStop };
    } catch (error) {
        // Reported, never thrown. Reconciling ten nodes must not stop at the first one that is
        // wedged — the other nine still need to converge, and the operator needs to see which failed.
        return {
            hostname: node.hostname,
            services,
            applied: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Reconcile every node that references a group.
 *
 * Invoked asynchronously by the fleet service when a group is created or updated.
 * One wedged or failing node does not halt convergence for the others.
 */
export async function reconcileGroup(
    ctx: IServiceContext,
    groupName: string,
): Promise<ReconcileOutcome[]> {
    const nodes = await nodesInGroup(ctx, groupName);
    if (nodes.length === 0) return [];

    const allGroups = (await ctx.call('group.find', { query: {} }) as GroupRecord[]) ?? [];
    const outcomes: ReconcileOutcome[] = [];

    for (const node of nodes) {
        try {
            outcomes.push(await reconcileNode(ctx, node, allGroups));
        } catch (error) {
            outcomes.push({
                hostname: node.hostname,
                services: resolveDesired(node, allGroups),
                applied: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return outcomes;
}
