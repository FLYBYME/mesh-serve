import type { IServiceContext } from '@flybyme/mesh';

import type { NodeLogsOutput } from '../contracts/node.contract.js';
import { readLogs } from '../methods/logBuffer.js';

/** Long enough for a busy node, short enough that a dead one fails the call quickly. */
const ASK_TIMEOUT_MS = 10_000;

/** This node's own buffer. */
export async function logsHere(input: { lines: number; grep?: string | undefined }, ctx: IServiceContext): Promise<NodeLogsOutput> {
    return { nodeID: ctx.nodeID, ...readLogs(input.lines, input.grep) };
}

/** The named node's buffer -- pinned to it, since only that node has its own lines. */
export async function logs(input: { nodeID: string; lines: number; grep?: string | undefined }, ctx: IServiceContext): Promise<NodeLogsOutput> {
    const query = { lines: input.lines, ...(input.grep !== undefined ? { grep: input.grep } : {}) };
    if (input.nodeID === ctx.nodeID) return logsHere(query, ctx);
    return ctx.call('serve.node.logsHere', query, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}
