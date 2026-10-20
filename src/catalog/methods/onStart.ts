import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { clearServiceRunning } from './services.js';
import { unloadAndEvictModule } from './loadModule.js';

export interface OnStartEntry {
    readonly contract: string;
    readonly params: Record<string, unknown>;
}

/**
 * Calls a just-mounted service's `onStart` contracts, in order, on this node.
 *
 * Mounting a part registers its contracts and calls none of them, so a `long-running` contract --
 * the only kind that binds a port -- was never started by anything. It cannot be started from
 * outside either: an api call lands on whichever node the load balancer picks, so two nameservers
 * sharing `dns.listen` cannot each be told to listen. Called here, inside the start itself, it runs
 * on the one node that just mounted the part, with no addressing to get wrong.
 *
 * All or nothing. A part "running" with its listener failed is worse than not running: the
 * supervisor sees it in `runningHere`, treats it as fine, and never tries again. So a failing entry
 * unloads the part again -- which also tears down any listener an earlier entry started, since
 * unregistering a `long-running` contract aborts its `ctx.signal` -- and throws, leaving the part
 * not-running for the next reconcile tick to retry from the top.
 */
export async function runOnStart(
    ctx: IServiceContext,
    part: { readonly id: string; readonly key: string; readonly onStart?: readonly OnStartEntry[] },
    modulePath: string,
    meta: Record<string, unknown>,
): Promise<void> {
    const labels = ctx.broker.registry.getNode(ctx.nodeID)?.metadata ?? {};

    for (const entry of part.onStart ?? []) {
        try {
            // The key is operator-declared data: callNamed refuses an unknown contract (404), and the
            // contract's own schema refuses bad params.
            await ctx.callNamed(entry.contract, nodeParams(entry.params, ctx.nodeID, labels), { meta });
        } catch (err) {
            await unloadAndEvictModule(ctx, modulePath);
            clearServiceRunning(ctx.nodeID, part.id);
            const reason = err instanceof Error ? err.message : String(err);
            throw new MeshError({
                message: `"${part.key}" mounted, but onStart "${entry.contract}" failed: ${reason}. Unloaded again so the next reconcile pass retries the whole start.`,
                code: 'ON_START_FAILED',
                status: 500,
            });
        }
    }
}

const NODE_REFERENCE = /\$\{node\.([A-Za-z0-9_-]+)\}/g;

/**
 * An onStart entry's params, with "${node.id}" and "${node.<label>}" in any string filled in from
 * the node it runs on. One part placed on every edge (placement "every") then still greets with
 * each machine's own name: smtp's { "hostname": "${node.fqdn}" } is edge1.surfdns.net on edge1 and
 * ns1.surfdns.net on ns1. A label the node does not carry throws, failing the start: an smtp
 * greeting with a literal "${node.fqdn}" would be worse than one that did not start.
 */
export function nodeParams(params: Record<string, unknown>, nodeID: string, labels: Record<string, unknown>): Record<string, unknown> {
    const fill = (value: unknown): unknown => {
        if (typeof value === 'string') {
            return value.replace(NODE_REFERENCE, (_whole, name: string) => {
                if (name === 'id') return nodeID;

                const label = labels[name];
                if (typeof label !== 'string') throw new Error(`"\${node.${name}}": node ${nodeID} has no "${name}" label`);

                return label;
            });
        }
        if (Array.isArray(value)) return value.map(fill);
        if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));

        return value;
    };

    return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, fill(value)]));
}
