import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, z } from '@flybyme/mesh';

import type { nodeLabelOutputSchema } from '../contracts/node.contract.js';
import { partsFromLabels, saveLabels, validLabel } from '../methods/labels.js';
import { getRunningService } from '../methods/services.js';
import { CORE_PART_NAMES } from '../contracts/corePart.contract.js';

type Output = z.infer<typeof nodeLabelOutputSchema>;
type Change = { set: Record<string, string>; remove: string[] };

const ASK_TIMEOUT_MS = 10_000;

function current(ctx: IServiceContext): Record<string, string> {
    const metadata = ctx.broker.registry.getNode(ctx.nodeID)?.metadata ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) if (typeof v === 'string') out[k] = v;
    return out;
}

/** This node's own labels: changed live, then saved so a restart keeps them. */
export async function labelHere(input: Change, ctx: IServiceContext): Promise<Output> {
    for (const [k, v] of Object.entries(input.set)) {
        if (!validLabel(k, v)) throw new MeshError({ message: `Not a label: "${k}=${v}"`, code: 'BAD_REQUEST', status: 400 });
    }
    const labels = { ...current(ctx), ...input.set };
    for (const k of input.remove) delete labels[k];
    await saveLabels(labels);
    ctx.broker.registry.setLocalMetadata(labels);
    ctx.logger.info(`[serve.node] labels now ${JSON.stringify(labels)}`);
    if ('parts' in input.set || input.remove.includes('parts')) await applyParts(labels, ctx);
    return { nodeID: ctx.nodeID, labels };
}

/**
 * The `parts` label is what this node runs of mesh-serve's core parts: a change loads what is new
 * first, then unloads what is gone -- the node never has less than it was asked for in between.
 * Removing the label leaves what is running alone; the boot flags decide again at the next start.
 */
async function applyParts(labels: Record<string, string>, ctx: IServiceContext): Promise<void> {
    const wanted = partsFromLabels(labels, CORE_PART_NAMES);
    if (wanted === undefined) return;
    const running = CORE_PART_NAMES.filter((name) => getRunningService(ctx.nodeID, `core:${name}`) !== undefined);
    for (const name of wanted.filter((n) => !running.includes(n))) {
        await ctx.call('serve.corePart.load', { name }, { nodeID: ctx.nodeID });
        ctx.logger.info(`[serve.node] core part "${name}" loaded (parts label)`);
    }
    for (const name of running.filter((n) => !wanted.includes(n))) {
        await ctx.call('serve.corePart.unload', { name }, { nodeID: ctx.nodeID });
        ctx.logger.info(`[serve.node] core part "${name}" unloaded (parts label)`);
    }
}

/** Pinned to the named node: only it can change its own labels. */
export async function label(input: Change & { nodeID: string }, ctx: IServiceContext): Promise<Output> {
    const change = { set: input.set, remove: input.remove };
    if (input.nodeID === ctx.nodeID) return labelHere(change, ctx);
    return ctx.call('serve.node.labelHere', change, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}
