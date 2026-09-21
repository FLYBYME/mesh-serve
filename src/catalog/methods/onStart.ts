import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, IServiceToolRegistry } from '@flybyme/mesh';

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
    for (const entry of part.onStart ?? []) {
        try {
            // The key is operator-declared data, validated by the call itself (unknown contract or
            // bad params both throw) -- the broker's generic can only be satisfied by a cast here.
            await ctx.call(entry.contract as keyof IServiceToolRegistry, entry.params as never, { meta });
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
