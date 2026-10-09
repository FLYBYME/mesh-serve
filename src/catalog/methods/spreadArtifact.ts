import type { IServiceBroker } from '@flybyme/mesh';

import { nodesForLabel } from './resolveNode.js';

/** How many nodes keep a full copy of every build, the one that made it included. */
export const ARTIFACT_COPIES = 2;

/** Nodes labelled so are asked first to keep copies: machines with disk to spare, that stay. */
export const KEEP_LABEL = 'artifacts=keep';

/** What spreading needs of a build record. */
export interface SpreadBuild {
    readonly id: string;
    readonly tenantId: string;
    readonly hash: string;
    readonly builtOn?: string | undefined;
    readonly heldBy?: readonly string[] | undefined;
}

/**
 * The nodes to ask for copies, in order: the `artifacts=keep` nodes, then every other available
 * node; never one that holds it already. Sorted by nodeID within each, so the same mesh gives the
 * same answer.
 */
export function copyTargets(available: readonly string[], keepers: readonly string[], holders: readonly string[]): string[] {
    const free = (id: string): boolean => !holders.includes(id);
    const first = keepers.filter((id) => available.includes(id) && free(id)).sort();
    const rest = available.filter((id) => free(id) && !first.includes(id)).sort();

    return [...first, ...rest];
}

/**
 * Makes sure `ARTIFACT_COPIES` nodes hold a build, and records which (`heldBy`). Builds live on
 * node disks, not in the database (owner, 10-09: 136 of 169 MB of the database was build files).
 * Each new holder copies it itself (`serve.artifact.pull` on that node), from a node that has it.
 * A node that fails is skipped for the next. Returns the holders it ended with -- fewer than wanted
 * is reported by the caller, never fatal: the build is on the node that made it, and can be built
 * again from its commit.
 */
export async function spreadArtifact(
    broker: IServiceBroker,
    build: SpreadBuild,
    options: { copies?: number; verify?: boolean } = {},
): Promise<{ holders: string[]; failures: string[] }> {
    const copies = options.copies ?? ARTIFACT_COPIES;
    const recorded = [...new Set([...(build.builtOn !== undefined ? [build.builtOn] : []), ...(build.heldBy ?? [])])];
    const failures: string[] = [];

    const available = broker.registry.getAvailableNodes().map((n) => n.nodeID);
    const keepers = nodesForLabel(broker.registry, KEEP_LABEL).map((n) => n.nodeID);
    const pullOn = async (nodeID: string): Promise<boolean> => {
        try {
            await broker.call('serve.artifact.pull', { artifactHash: build.hash }, { nodeID, meta: { tenant_id: build.tenantId } });
            return true;
        } catch (err) {
            failures.push(`${nodeID}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    // Verified: each recorded holder that is up is asked to pull, which answers at once when the
    // copy is there and fetches it when not (a pod's fresh disk). A holder that cannot is dropped.
    // Unverified (just built): the record is trusted.
    const holders: string[] = [];
    for (const nodeID of recorded) {
        if (options.verify !== true) holders.push(nodeID);
        else if (available.includes(nodeID) && await pullOn(nodeID)) holders.push(nodeID);
    }

    for (const target of copyTargets(available, keepers, holders)) {
        if (holders.filter((h) => available.includes(h)).length >= copies) break;
        if (await pullOn(target)) holders.push(target);
    }

    const heldBy = holders.filter((h) => h !== build.builtOn);
    if (heldBy.join() !== (build.heldBy ?? []).join()) {
        await broker.call('serve.artifact.update', { id: build.id, heldBy }, { meta: { tenant_id: build.tenantId } });
    }

    return { holders, failures };
}

/** `spreadArtifact` after a build or an import: short of copies is said loudly, never thrown. */
export async function keepCopies(broker: IServiceBroker, build: SpreadBuild): Promise<void> {
    try {
        const { holders, failures } = await spreadArtifact(broker, build);
        if (holders.length < ARTIFACT_COPIES) {
            broker.logger.error(`Build ${build.id} (${build.hash.slice(0, 12)}) is on ${holders.length} of ${ARTIFACT_COPIES} nodes (${holders.join(', ') || 'none'})${failures.length > 0 ? `: ${failures.join('; ')}` : ''}`);
        }
    } catch (err) {
        broker.logger.error(`Build ${build.id} (${build.hash.slice(0, 12)}) was not copied to another node: ${err instanceof Error ? err.message : String(err)}`);
    }
}
