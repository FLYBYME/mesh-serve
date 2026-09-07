import os from 'node:os';
import { ClientError } from '@flybyme/mesh';

export interface PlacementCandidate {
    nodeID: string;
    hostname?: string;
    available?: boolean;
}

export interface CallWithPlacementOptions {
    timeout?: number;
    meta?: unknown;
}

/**
 * Resolves configured or live node memory in megabytes.
 * Overridable via MESH_NODE_MEMORY_MB for testing and constraint enforcement.
 */
export function getNodeMemoryMB(): number {
    if (process.env['MESH_NODE_MEMORY_MB']) {
        return Number(process.env['MESH_NODE_MEMORY_MB']);
    }
    return Math.round(os.totalmem() / (1024 * 1024));
}

/**
 * Returns candidate nodes mounting a tool from the broker or its registry.
 */
export function getCandidateNodes(brokerOrApp: unknown, toolName: string): PlacementCandidate[] {
    const b = brokerOrApp as {
        getProvider?<T>(name: string): T;
        registry?: {
            findNodesForTool?(tool: string): { nodeID: string; hostname?: string; available?: boolean }[];
            getNodes?(): { nodeID: string; hostname?: string; available?: boolean; services?: { tools?: Record<string, unknown>; name?: string }[] }[];
        };
    };
    const registry = b.getProvider?.<any>('registry') ?? b.registry;
    if (registry?.findNodesForTool && typeof registry.findNodesForTool === 'function') {
        const nodes = registry.findNodesForTool(toolName);
        if (Array.isArray(nodes) && nodes.length > 0) {
            return nodes;
        }
    }
    if (registry?.getNodes && typeof registry.getNodes === 'function') {
        const allNodes = registry.getNodes() ?? [];
        return allNodes.filter((n: any) => {
            if (n.available === false) return false;
            return n.services?.some((s: any) => s.tools && (s.tools[toolName] || (s.name && toolName.startsWith(`${s.name}.`))));
        });
    }
    return [];
}

/**
 * Orders candidate nodes for placement, respecting caller's `preferLocal`
 * to keep work on the local machine when capable instead of round-robining to remote peers.
 */
export function orderCandidatesForPlacement(
    candidates: PlacementCandidate[],
    options: {
        preferLocal?: boolean;
        localNodeID?: string;
        localHostname?: string;
    } = {},
): PlacementCandidate[] {
    if (!options.preferLocal) {
        return [...candidates];
    }

    const localNodeID = options.localNodeID;
    const localHostname = options.localHostname ?? os.hostname();

    const isLocal = (c: PlacementCandidate): boolean =>
        (localNodeID !== undefined && c.nodeID === localNodeID) ||
        (c.hostname !== undefined && c.hostname === localHostname);

    const localCandidates = candidates.filter(isLocal);
    const remoteCandidates = candidates.filter((c) => !isLocal(c));

    return [...localCandidates, ...remoteCandidates];
}

/**
 * Executes a tool call with placement awareness and automatic fallback if a node declines
 * due to insufficient resources.
 */
export async function callWithPlacement<T = unknown>(
    brokerOrApp: unknown,
    toolName: string,
    params: Record<string, unknown>,
    options?: CallWithPlacementOptions,
): Promise<T> {
    const caller = brokerOrApp as {
        nodeID?: string;
        call(tool: string, params: unknown, opts?: { nodeID?: string; timeout?: number; meta?: unknown }): Promise<T>;
        getProvider?<U>(name: string): U;
        registry?: unknown;
    };

    const candidates = getCandidateNodes(caller, toolName);
    const preferLocal = Boolean(params['preferLocal']);

    // If no specific candidates discovered via registry, proceed with default broker dispatch
    if (candidates.length === 0) {
        return await caller.call(toolName, params, options);
    }

    const ordered = orderCandidatesForPlacement(candidates, {
        preferLocal,
        localNodeID: caller.nodeID,
        localHostname: os.hostname(),
    });

    let lastError: Error | undefined;
    for (const candidate of ordered) {
        try {
            return await caller.call(toolName, params, {
                ...options,
                nodeID: candidate.nodeID,
            });
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // Fallback when candidate node declines work due to resource constraints
            if (err instanceof ClientError && err.code === 'insufficient_memory') {
                continue;
            }
            // Domain and validation failures escape immediately
            throw err;
        }
    }

    throw lastError ?? new ClientError(`No capable node found for ${toolName}`, 'placement_failed', 503);
}
