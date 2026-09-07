import os from 'node:os';
import type { IServiceContext, IServiceRegistry } from '@flybyme/mesh';
import type { NodeRecord, NodeStatusReport, NodeSummary, ServiceRunStatus } from '../schema/node.js';

function assertOperatorIfUserPresent(ctx: IServiceContext): void {
    const user = ctx.meta?.user as { roles?: readonly string[] } | undefined;
    if (user !== undefined && user !== null) {
        const roles = Array.isArray(user.roles) ? user.roles : [];
        if (!roles.includes('operator')) {
            const error = new Error('Fleet operations require the operator role.');
            (error as unknown as { status: number; code: string }).status = 403;
            (error as unknown as { status: number; code: string }).code = 'FORBIDDEN';
            throw error;
        }
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
    input: { hostname: string },
    ctx: IServiceContext,
): Promise<{ hostname: string; services: string[] }> {
    assertOperatorIfUserPresent(ctx);

    // E3: Refuse if another live node in the Registry already claims this hostname
    const registryNodes = getRegistryNodes(ctx.broker);
    const liveConflict = registryNodes.find(
        (n) => (n.available ?? true) && n.hostname === input.hostname && n.nodeID !== ctx.nodeID,
    );
    if (liveConflict) {
        throw new Error(
            `[fleet] Hostname "${input.hostname}" is already claimed by live node "${liveConflict.nodeID}".`,
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
 * node.assign: sets the desired services for a node by hostname.
 *
 * Assignment is a switch. It results in supervisor.service_start / service_stop
 * on the target node live if it is currently running, without restarting the node.
 */
export async function node_assign(
    input: { hostname: string; services: string[] },
    ctx: IServiceContext,
): Promise<{
    hostname: string;
    services: string[];
    applied: boolean;
    started?: string[];
    stopped?: string[];
    error?: string;
}> {
    assertOperatorIfUserPresent(ctx);

    // 1. Update or create desired state in DB
    const existing = await ctx.call('node.find_one', {
        query: { hostname: input.hostname },
    }) as (NodeRecord & { id: string }) | null;

    if (existing !== null && existing !== undefined) {
        await ctx.call('node.update', {
            id: existing.id,
            services: input.services,
        });
    } else {
        await ctx.call('node.create', {
            hostname: input.hostname,
            services: input.services,
        });
    }

    // 2. Check if the target node is online in Registry
    const registryNodes = getRegistryNodes(ctx.broker);
    const targetNode = registryNodes.find(
        (n) => (n.available ?? true) && n.hostname === input.hostname,
    );

    if (!targetNode) {
        // Not currently live: desired state is saved in DB and will be applied on hello
        return {
            hostname: input.hostname,
            services: input.services,
            applied: false,
        };
    }

    // 3. Target node is live: execute the switch live via supervisor
    try {
        const broker = ctx.broker;
        const callTargetOpt = targetNode.nodeID !== broker.nodeID ? { nodeID: targetNode.nodeID } : undefined;

        const statusResult = await broker.call(
            'supervisor.service_status' as never,
            {} as never,
            callTargetOpt,
        ) as { services: { name: string; status: string }[] };

        const currentlyRunning = new Set(
            (statusResult.services ?? [])
                .filter((s) => s.status === 'running')
                .map((s) => s.name),
        );
        const desired = new Set(input.services);

        const toStop = [...currentlyRunning].filter((s) => !desired.has(s));
        const toStart = input.services.filter((s) => !currentlyRunning.has(s));

        // Stop services that should no longer run (cascade: true)
        for (const name of toStop) {
            await broker.call(
                'supervisor.service_stop' as never,
                { name, cascade: true } as never,
                callTargetOpt,
            );
        }

        // Start services that should run
        for (const name of toStart) {
            await broker.call(
                'supervisor.service_start' as never,
                { name } as never,
                callTargetOpt,
            );
        }

        return {
            hostname: input.hostname,
            services: input.services,
            applied: true,
            started: toStart,
            stopped: toStop,
        };
    } catch (err) {
        return {
            hostname: input.hostname,
            services: input.services,
            applied: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * node.status: answers what this node is running and what it is connected to.
 *
 * It is the direct answer to "stale mongo, stale k3d, nobody knows anything"
 * and reports both desired state from DB and observed state from Registry/Supervisor.
 */
export async function node_status(
    input: { hostname?: string },
    ctx: IServiceContext,
): Promise<NodeStatusReport> {
    assertOperatorIfUserPresent(ctx);

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
