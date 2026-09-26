import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, z } from '@flybyme/mesh';

import type { nodeVersionOutputSchema } from '../contracts/node.contract.js';
import { hostAgentInstalled, readUpgradeResult, runningVersion, writeUpgradeRequest } from '../methods/upgrade.js';

type Output = z.infer<typeof nodeVersionOutputSchema>;

const ASK_TIMEOUT_MS = 10_000;

async function report(ctx: IServiceContext, requested?: string): Promise<Output> {
    const last = await readUpgradeResult();
    return {
        nodeID: ctx.nodeID, running: runningVersion(), agentInstalled: await hostAgentInstalled(),
        ...(requested !== undefined ? { requested } : {}),
        ...(last !== undefined ? { last } : {}),
    };
}

export async function versionHere(_input: Record<string, never>, ctx: IServiceContext): Promise<Output> {
    return report(ctx);
}

export async function upgradeHere(input: { version: string }, ctx: IServiceContext): Promise<Output> {
    if (!(await hostAgentInstalled())) {
        throw new MeshError({
            message: `${ctx.nodeID}'s host cannot upgrade it: the upgrade agent is not installed (deploy/node-upgrade/install.sh).`,
            code: 'PRECONDITION_FAILED', status: 412,
        });
    }
    await writeUpgradeRequest(input.version);
    ctx.logger.info(`[serve.node] upgrade to ${input.version} requested of the host (running ${runningVersion()})`);
    return report(ctx, input.version);
}

/** Pinned to the named node: only that node's host can act, and only it knows its release. */
export async function version(input: { nodeID: string }, ctx: IServiceContext): Promise<Output> {
    if (input.nodeID === ctx.nodeID) return report(ctx);
    return ctx.call('serve.node.versionHere', {}, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}

export async function upgrade(input: { nodeID: string; version: string }, ctx: IServiceContext): Promise<Output> {
    if (input.nodeID === ctx.nodeID) return upgradeHere({ version: input.version }, ctx);
    return ctx.call('serve.node.upgradeHere', { version: input.version }, { nodeID: input.nodeID, timeout: ASK_TIMEOUT_MS });
}
