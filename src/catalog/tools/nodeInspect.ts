import inspector from 'node:inspector';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { IServiceContext, z } from '@flybyme/mesh';

import type { nodeInspectOutputSchema } from '../contracts/node.contract.js';

type Output = z.infer<typeof nodeInspectOutputSchema>;
type Change = { minutes: number; close: boolean };

/** The inspector's port, on 127.0.0.1 only: never a fleet or public address. */
export const INSPECT_PORT = 9229;
const INSPECT_HOST = '127.0.0.1';
const ASK_TIMEOUT_MS = 10_000;
const NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

let closeTimer: ReturnType<typeof setTimeout> | undefined;
let closesAt: Date | undefined;

/** The pod this node runs in -- its hostname is the pod's name, its namespace the service account's -- or undefined on a host. */
function podOf(): { name: string; namespace: string } | undefined {
    try {
        return { name: os.hostname(), namespace: readFileSync(NAMESPACE_FILE, 'utf8').trim() };
    } catch {
        return undefined;
    }
}

/** The commands that reach it from a laptop: ssh to the machine and, in a pod, port-forward into it. */
export function reachCommands(pod: { name: string; namespace: string } | undefined): string {
    const port = INSPECT_PORT;
    const tunnel = pod === undefined
        ? `ssh -N -L ${port}:127.0.0.1:${port} surfdns@<this machine>`
        : `ssh -L ${port}:127.0.0.1:${port} surfdns@<the machine it runs on> sudo k3s kubectl -n ${pod.namespace} port-forward pod/${pod.name} ${port}:${port}`;

    return `${tunnel}\nthen chrome://inspect -> Configure -> localhost:${port} (or any DevTools client)`;
}

function close(ctx: IServiceContext, why: string): void {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = undefined;
    closesAt = undefined;
    if (inspector.url() !== undefined) {
        inspector.close();
        ctx.logger.warn(`[serve.node] inspector closed (${why})`);
    }
}

/** This node's inspector: opened on its localhost for `minutes` (again: the time starts over), or closed. */
export async function inspectHere(input: Change, ctx: IServiceContext): Promise<Output> {
    if (input.close) {
        close(ctx, 'asked');
        return { nodeID: ctx.nodeID, open: false };
    }

    if (inspector.url() === undefined) {
        inspector.open(INSPECT_PORT, INSPECT_HOST, false);
        ctx.logger.warn(`[serve.node] inspector OPEN on ${INSPECT_HOST}:${INSPECT_PORT} for ${input.minutes} min (serve.node.inspect)`);
    }
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closesAt = new Date(Date.now() + input.minutes * 60_000);
    closeTimer = setTimeout(() => close(ctx, `its ${input.minutes} min were up`), input.minutes * 60_000);
    closeTimer.unref();

    const url = inspector.url();

    return {
        nodeID: ctx.nodeID,
        open: url !== undefined,
        ...(url !== undefined ? { url } : {}),
        closesAt: closesAt.toISOString(),
        reach: reachCommands(podOf()),
    };
}

/** Pinned to the named node: only it can open its own inspector. */
export async function inspect(input: Change & { nodeID: string }, ctx: IServiceContext): Promise<Output> {
    const change = { minutes: input.minutes, close: input.close };
    if (input.nodeID === ctx.nodeID) return inspectHere(change, ctx);

    return ctx.call('serve.node.inspectHere', change, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}
