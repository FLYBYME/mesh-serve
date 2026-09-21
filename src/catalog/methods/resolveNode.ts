import type { IServiceRegistry, NodeInfo } from '@flybyme/mesh';

/**
 * Every available node advertising a given "key=value" label (`NodeInfo.metadata`, set by
 * `mesh-serve start --labels ...`). A node that has gone quiet is never included -- only
 * `getAvailableNodes()` is considered. Sorted by nodeID so callers that need one stable answer
 * (resolveNodeSelector) and callers that want to list every match (serve.node.find) agree on
 * order.
 */
export function nodesForLabel(registry: IServiceRegistry, label: string): NodeInfo[] {
    const eq = label.indexOf('=');
    if (eq === -1) {
        throw new Error(`"${label}" is not a "key=value" label.`);
    }
    const key = label.slice(0, eq);
    const value = label.slice(eq + 1);
    return registry.getAvailableNodes()
        .filter((node) => node.metadata?.[key] === value)
        .sort((a, b) => a.nodeID.localeCompare(b.nodeID));
}

/**
 * One node, by exact nodeID or by a "key=value" label match -- the first, in nodeID order, of
 * whatever `nodesForLabel` finds. Multiple nodes can share a label (e.g. two DNS boxes); picking
 * the first in a stable order means a given selector resolves to the same node on every call, as
 * long as the same set of nodes is online, rather than whichever happened to iterate first.
 *
 * Shared by `serve.part.reconcile` (pinned placement) and `serve.node.find` (the "what's online
 * under this label" lookup an operator makes before pinning something to it).
 */
export function resolveNodeSelector(registry: IServiceRegistry, selector: string): NodeInfo | undefined {
    if (!selector.includes('=')) {
        return registry.getNode(selector);
    }
    return nodesForLabel(registry, selector)[0];
}
