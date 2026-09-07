/**
 * The fleet's tools: which machines exist, what each should run, and what each actually runs.
 *
 * Every input and output type here comes from the contract by `z.infer`, the way `cdn/tools/*` do.
 * They were hand-written object literals repeating the schema, which is the drift the contracts
 * exist to prevent — the schema would change and the signature would go on claiming the old shape.
 */

import os from 'node:os';
import { ClientError, z, type IServiceContext, type IServiceRegistry } from '@flybyme/mesh';

import type {
    nodeAssignContract, nodeHelloContract, nodeReconcileContract, nodeStatusContract,
} from '../contracts/node.contract.js';
import type { GroupRecord, NodeRecord, NodeSummary, ServiceRunStatus } from '../schema/node.js';
import { nodesInGroup, reconcileNode } from './reconcile.js';

type HelloInput = z.infer<typeof nodeHelloContract['inputSchema']>;
type HelloOutput = z.infer<typeof nodeHelloContract['outputSchema']>;
type AssignInput = z.infer<typeof nodeAssignContract['inputSchema']>;
type AssignOutput = z.infer<typeof nodeAssignContract['outputSchema']>;
type ReconcileInput = z.infer<typeof nodeReconcileContract['inputSchema']>;
type ReconcileOutput = z.infer<typeof nodeReconcileContract['outputSchema']>;
type StatusInput = z.infer<typeof nodeStatusContract['inputSchema']>;
type StatusOutput = z.infer<typeof nodeStatusContract['outputSchema']>;

/**
 * An operator, and **an absent caller is not one**.
 *
 * This was `assertOperatorIfUserPresent`, which checked the role only when `ctx.meta.user` was
 * there and allowed the call outright when it was not. Every caller that reaches these tools over
 * the broker rather than through the HTTP gate — which is every mesh peer — arrives with no
 * `meta.user`, so the fleet's control surface was open to anything already on the mesh. The name
 * said so and it still read as a check.
 *
 * [auth §5](../../../spec/auth.md), roadmap C2.5: *no internal bypass, no god token, no
 * trusted-caller exemption*. Being on the mesh is not an identity.
 */
function requireOperator(ctx: IServiceContext, action: string): void {
    const user = ctx.meta?.user as { roles?: readonly string[] } | undefined;

    if (user === undefined || user === null) {
        throw new ClientError(
            `node.${action} requires an operator, and this call carries no caller at all. `
            + `Reaching a tool over the mesh is not an identity.`,
            'unauthenticated', 401,
        );
    }

    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (!roles.includes('operator')) {
        throw new ClientError(
            `node.${action} requires the operator role.`, 'forbidden', 403,
        );
    }
}

interface MeshRegistryNode {
    nodeID: string;
    hostname?: string;
    available?: boolean;
    addresses?: string[];
}

function getRegistryNodes(broker: unknown): MeshRegistryNode[] {
    const b = broker as { getProvider?<T>(name: string): T; registry?: IServiceRegistry };
    const registry = b.getProvider?.<IServiceRegistry>('registry') ?? b.registry;
    if (registry && typeof registry.getNodes === 'function') {
        return registry.getNodes() as MeshRegistryNode[];
    }
    return [];
}

/**
 * node.hello: a node announces itself by hostname and asks what services it should run.
 *
 * Desired state only. The fleet only ever answers — it never starts a process.
 * If the node is new, an assignment row is created with empty desired services.
 * Refuses if another live node in the mesh already claims the same hostname (E3).
 */
export async function node_hello(
    input: HelloInput,
    ctx: IServiceContext,
): Promise<HelloOutput> {
    /**
     * **No operator check here, and it is the one deliberate exception in this file.**
     *
     * `hello` is a *machine* announcing itself, not a person doing something. A node has no user and
     * never will have one, so an operator check here means no node can ever register — and the
     * obvious workaround, giving every machine an operator credential, would hand the fleet's entire
     * control surface to every box in the fleet. That is a worse outcome than this exception.
     *
     * **Three things bound it, and they are the reason this is safe rather than merely convenient:**
     *
     * 1. `nodeHelloContract` declares no `visibility`, so mesh defaults it to `internal` and no site
     *    can expose it. It is unreachable from the internet, and a test below pins that.
     * 2. The caller has already proved it belongs on the mesh: a peer presents the shared key at the
     *    WebSocket handshake or it never becomes a peer. Authenticating the *peer relationship* is
     *    the transport's job and it is the right layer for it.
     * 3. It reads nothing it is not told and writes only the row for the hostname it names, so the
     *    worst a lying node achieves is taking another node's assignment — which the conflict check
     *    below catches while that node is live.
     *
     * `assign`, `reconcile` and `status` are operator-only and stay that way. Announcing yourself is
     * not the same act as directing somebody else.
     */

    // E3: Refuse if another live node in the Registry already claims this hostname
    const registryNodes = getRegistryNodes(ctx.broker);
    const liveConflict = registryNodes.find(
        (n) => (n.available ?? true) && n.hostname === input.hostname && n.nodeID !== ctx.nodeID,
    );
    if (liveConflict) {
        // A named failure, not a bare Error: a caller deciding what to do about a hostname clash
        // needs to tell it apart from the node being down, and a message string is not something
        // anything can branch on.
        throw new ClientError(
            `Hostname "${input.hostname}" is already claimed by live node `
            + `"${liveConflict.nodeID}". Two machines announcing one hostname means one of them `
            + `takes the other's assignment.`,
            'hostname_claimed', 409,
        );
    }

    const existing = await ctx.call('node.find_one', {
        query: { hostname: input.hostname },
    }) as (NodeRecord & { id: string }) | null;

    if (existing !== null && existing !== undefined) {
        return {
            hostname: existing.hostname,
            services: existing.services ?? [],
        };
    }

    await ctx.call('node.create', {
        hostname: input.hostname,
        services: [],
    });

    return {
        hostname: input.hostname,
        services: [],
    };
}

/**
 * node.assign: what a node should be running, as services, groups, or both.
 *
 * **Assignment is a switch.** It changes which of the services a node already carries are running,
 * live, without restarting the node — that separation is what keeps systemd (which owns the
 * process) and the Supervisor (which owns services inside it) from being two authorities over one
 * thing.
 *
 * Both fields are optional and **absent means unchanged**, not empty. `{ hostname, groups: ['edge'] }`
 * puts a node in a group without silently clearing the services it was given directly, which is the
 * mistake the obvious implementation makes and which is invisible until a builder stops.
 */
export async function node_assign(
    input: AssignInput,
    ctx: IServiceContext,
): Promise<AssignOutput> {
    requireOperator(ctx, 'assign');

    const existing = await ctx.call('node.find_one', {
        query: { hostname: input.hostname },
    }) as (NodeRecord & { id: string }) | null;

    const services = input.services ?? existing?.services ?? [];
    const groups = input.groups ?? existing?.groups ?? [];

    if (existing !== null && existing !== undefined) {
        await ctx.call('node.update', { id: existing.id, services, groups });
    } else {
        await ctx.call('node.create', { hostname: input.hostname, services, groups });
    }

    const allGroups = await ctx.call('group.find', { query: {} }) as GroupRecord[];
    return await reconcileNode(ctx, { hostname: input.hostname, services, groups }, allGroups ?? []);
}

/**
 * node.reconcile: make what is running match what should be running.
 *
 * The verb that makes a group mean something. Editing a group changes no running process by itself;
 * reconciling the nodes in it does. Idempotent, so it is safe to call on a whole fleet when
 * something looks wrong, and safe to call twice.
 *
 * With no hostname it reconciles every node, and it does **not** stop at the first failure — nine
 * healthy nodes still need to converge when the tenth is wedged, and the operator needs to see
 * which one it was.
 */
export async function node_reconcile(
    input: ReconcileInput,
    ctx: IServiceContext,
): Promise<ReconcileOutput> {
    requireOperator(ctx, 'reconcile');

    const groups = (await ctx.call('group.find', { query: {} }) as GroupRecord[]) ?? [];

    let nodes: NodeRecord[];
    if (input.hostname !== undefined) {
        const one = await ctx.call('node.find_one', {
            query: { hostname: input.hostname },
        }) as NodeRecord | null;
        nodes = one === null || one === undefined ? [] : [one];
    } else if (input.group !== undefined) {
        nodes = await nodesInGroup(ctx, input.group);
    } else {
        nodes = (await ctx.call('node.find', { query: {} }) as NodeRecord[]) ?? [];
    }

    const reconciled: ReconcileOutput['reconciled'][number][] = [];
    for (const node of nodes) reconciled.push(await reconcileNode(ctx, node, groups));
    return { reconciled };
}

/**
 * node.status: answers what this node is running and what it is connected to.
 *
 * It is the direct answer to "stale mongo, stale k3d, nobody knows anything"
 * and reports both desired state from DB and observed state from Registry/Supervisor.
 */
export async function node_status(
    input: StatusInput,
    ctx: IServiceContext,
): Promise<StatusOutput> {
    requireOperator(ctx, 'status');

    const broker = ctx.broker;
    const registryNodes = getRegistryNodes(broker);

    const myNode = registryNodes.find((n) => n.nodeID === broker.nodeID);
    const targetHostname = input.hostname ?? myNode?.hostname ?? os.hostname();

    // Query desired services from DB
    const nodeRow = await ctx.call('node.find_one', {
        query: { hostname: targetHostname },
    }) as (NodeRecord & { id: string }) | null;
    const desiredServices = nodeRow?.services ?? [];

    // Find target in Registry
    const targetMeshNode = registryNodes.find((n) => n.hostname === targetHostname);
    const connected = targetMeshNode !== undefined && (targetMeshNode.available ?? true);

    // List peers (all nodes in Registry except the target itself)
    const peers = registryNodes
        .filter((n) => n.nodeID !== targetMeshNode?.nodeID)
        .map((n) => ({
            nodeID: n.nodeID,
            hostname: n.hostname,
            addresses: n.addresses ?? [],
        }));

    let runningServices: string[] = [];
    let services: ServiceRunStatus[] | undefined;
    let error: string | undefined;

    if (connected && targetMeshNode) {
        try {
            const callTargetOpt = targetMeshNode.nodeID !== broker.nodeID ? { nodeID: targetMeshNode.nodeID } : undefined;
            const statusResult = await broker.call(
                'supervisor.service_status' as never,
                {} as never,
                callTargetOpt,
            ) as { services: ServiceRunStatus[] };

            services = statusResult.services ?? [];
            runningServices = services.filter((s) => s.status === 'running').map((s) => s.name);
        } catch (err) {
            error = `Failed to query supervisor on node "${targetHostname}": ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    // Build fleet summary
    const allDbNodes = await ctx.call('node.find', { query: {}, limit: 100 }) as (NodeRecord & { id: string })[];
    const knownHostnames = new Set<string>();
    for (const row of (allDbNodes ?? [])) knownHostnames.add(row.hostname);
    for (const mNode of registryNodes) {
        if (mNode.hostname) knownHostnames.add(mNode.hostname);
    }

    const nodesSummary: NodeSummary[] = [];
    for (const host of knownHostnames) {
        const mNode = registryNodes.find((n) => n.hostname === host);
        const dRow = (allDbNodes ?? []).find((r) => r.hostname === host);
        nodesSummary.push({
            hostname: host,
            nodeID: mNode?.nodeID,
            connected: mNode !== undefined && (mNode.available ?? true),
            desiredServices: dRow?.services ?? [],
            runningServices: host === targetHostname ? runningServices : [],
        });
    }

    return {
        hostname: targetHostname,
        nodeID: targetMeshNode?.nodeID,
        connected,
        peers,
        desiredServices,
        runningServices,
        ...(services !== undefined ? { services } : {}),
        nodes: nodesSummary,
        ...(error !== undefined ? { error } : {}),
    };
}
