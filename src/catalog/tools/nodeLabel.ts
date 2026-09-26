import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, z } from '@flybyme/mesh';

import type { nodeLabelOutputSchema } from '../contracts/node.contract.js';
import { saveLabels, validLabel } from '../methods/labels.js';

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
    return { nodeID: ctx.nodeID, labels };
}

/** Pinned to the named node: only it can change its own labels. */
export async function label(input: Change & { nodeID: string }, ctx: IServiceContext): Promise<Output> {
    const change = { set: input.set, remove: input.remove };
    if (input.nodeID === ctx.nodeID) return labelHere(change, ctx);
    return ctx.call('serve.node.labelHere', change, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}
