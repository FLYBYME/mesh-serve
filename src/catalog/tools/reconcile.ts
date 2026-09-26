import { Database } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { partCrud } from '../contracts/part.contract.js';
import type { PartReconcileOutput } from '../contracts/supervisor.contract.js';
import { resolveNodeSelector } from '../methods/resolveNode.js';

/**
 * One pass of desired-vs-observed.
 *
 * Cross-tenant, so it reads through `Database.repo` rather than `ctx.db`: there is no single
 * tenant a cluster-wide sweep runs as, and therefore no `meta.tenant_id` that could be correct --
 * the same reasoning `watchRelease` gives. Every *write* it then makes is scoped to the part's own
 * tenant, which it knows from the row.
 */
export async function reconcile(_params: Record<string, never>, ctx: IServiceContext): Promise<PartReconcileOutput> {
    const db = ctx.broker.getProvider<Database>('database');
    const repo = db.repo(partCrud.get.outputSchema, 'serve.part');

    const services = (await repo.find({ query: { kind: 'service' } }))
        .map((raw) => partCrud.get.outputSchema.parse(raw));
    if (services.length === 0) {
        return { started: [], stopped: [], redeployed: [], failed: [] };
    }

    // Observed: ask every node what it is running. A node that has died is absent from the
    // registry and simply is not asked, which is exactly the signal we want -- there is no stale
    // record of it claiming to still host anything.
    const nodes = ctx.broker.registry.getNodes();
    const observed = new Map<string, { nodeID: string; artifactId?: string | undefined }>(); // by partId
    const unanswered: string[] = [];

    for (const node of nodes) {
        try {
            const report = await ctx.call('serve.part.runningHere', {}, { nodeID: node.nodeID });
            for (const service of report.services) {
                observed.set(service.partId, { nodeID: report.nodeID, artifactId: service.artifactId });
            }
        } catch (err) {
            // A node that cannot answer is one we cannot reason about -- it may be running anything.
            // Its report is missing, so every part it holds looks "not running" below; `unanswered`
            // is what stops that from reading as a reason to start them (see the start branch).
            unanswered.push(node.nodeID);
            ctx.logger.warn(`serve.part.reconcile: ${node.nodeID} did not report what it is running; nothing unseen is started this pass`, err);
        }
    }

    const started: PartReconcileOutput['started'] = [];
    const stopped: PartReconcileOutput['stopped'] = [];
    const redeployed: PartReconcileOutput['redeployed'] = [];
    const failed: PartReconcileOutput['failed'] = [];

    for (const part of services) {
        const observedRun = observed.get(part.id);
        const runningOn = observedRun?.nodeID;

        // Running, but not the build it is pinned to: the pin moved (a deploy or a rollback). Restart
        // it in place, on the node it already runs on -- placement is not what changed. Only a pinned
        // part is compared; an unpinned one has no declared build to be out of date against.
        if (
            part.desired === 'running' && observedRun !== undefined
            && part.artifactId !== undefined && observedRun.artifactId !== part.artifactId
        ) {
            const scoped = { nodeID: observedRun.nodeID, meta: { tenant_id: part.tenantId } };
            try {
                await ctx.call('serve.part.stop', { id: part.id }, scoped);
                // If this start fails the part is now simply not running, and the next pass's
                // not-running branch retries it like any other missing service.
                await ctx.call('serve.part.start', { id: part.id }, scoped);
                redeployed.push({
                    partId: part.id,
                    key: part.key,
                    nodeID: observedRun.nodeID,
                    ...(observedRun.artifactId !== undefined ? { from: observedRun.artifactId } : {}),
                    to: part.artifactId,
                });
                ctx.logger.info(`serve.part.reconcile: redeployed "${part.key}" on ${observedRun.nodeID}: ${observedRun.artifactId ?? '(unknown)'} -> ${part.artifactId}`);
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                failed.push({ partId: part.id, key: part.key, error });
            }
            continue;
        }

        if (part.desired === 'running' && runningOn === undefined && unanswered.length > 0) {
            // Not seen running -- but a node that did not answer may be running it. Starting it
            // would load a second copy (elsewhere) or pile a start onto a node already struggling
            // (on it): skipping it was the intent, and a report with a missing node used to be read
            // as "running nothing" (surf tried to start edge1's parts on edge1, 2026-09-26).
            failed.push({ partId: part.id, key: part.key, error: `not started: ${unanswered.join(', ')} did not answer, and may already be running it` });
            continue;
        }

        if (part.desired === 'running' && runningOn === undefined) {
            // A declared nodeSelector is a pin, not a hint: honor it or fail loudly, never fall back
            // to automatic placement silently. Real physical constraints (DNS on the box with the
            // right PTR record, mail on the box with the established sending IP) mean "somewhere" is
            // sometimes the wrong answer, and a pin that quietly landed elsewhere would be worse than
            // one that visibly failed.
            //
            // With no selector: `placementFor`, not `leaderFor` -- the latter only considers nodes
            // already advertising the thing, so for a service nobody is running it answers undefined
            // -- correctly, and uselessly here. Deterministic either way, so every pass agrees on
            // where this belongs without remembering a previous decision, and the answer moves on its
            // own when a node leaves.
            const target = part.nodeSelector !== undefined
                ? resolveNodeSelector(ctx.broker.registry, part.nodeSelector)
                : ctx.broker.registry.placementFor(part.key);
            if (target === undefined) {
                const error = part.nodeSelector !== undefined
                    ? `no online node matches nodeSelector "${part.nodeSelector}"`
                    : 'no node available to place it on';
                failed.push({ partId: part.id, key: part.key, error });
                continue;
            }

            try {
                // Scoped to the part's own tenant. The sweep itself is cross-tenant and carries no
                // tenant_id, but everything it *does* is on behalf of one part, and startService
                // reads serve.part through ctx.db -- which rightly refuses an unscoped read.
                await ctx.call('serve.part.start', { id: part.id }, { nodeID: target.nodeID, meta: { tenant_id: part.tenantId } });
                started.push({ partId: part.id, key: part.key, nodeID: target.nodeID });
                ctx.logger.info(`serve.part.reconcile: started "${part.key}" on ${target.nodeID}`);
            } catch (err) {
                // Reported, not thrown. A part with no successful build fails here every pass, and
                // one bad part must not stall every other service in the cluster.
                const error = err instanceof Error ? err.message : String(err);
                failed.push({ partId: part.id, key: part.key, error });
            }
            continue;
        }

        if (part.desired === 'stopped' && runningOn !== undefined) {
            try {
                await ctx.call('serve.part.stop', { id: part.id }, { nodeID: runningOn, meta: { tenant_id: part.tenantId } });
                stopped.push({ partId: part.id, key: part.key, nodeID: runningOn });
                ctx.logger.info(`serve.part.reconcile: stopped "${part.key}" on ${runningOn}`);
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                failed.push({ partId: part.id, key: part.key, error });
            }
        }
    }

    reportFailures(ctx, failed);
    return { started, stopped, redeployed, failed };
}

/** The last error logged for each part that is failing, by partId -- see reportFailures. */
const lastFailure = new Map<string, { key: string; error: string }>();

/**
 * `failed` is only ever returned, and an interval contract's return value goes nowhere: a part
 * whose start kept failing was invisible -- no log on the leader, and nothing on the target node,
 * which never got far enough to log anything itself. Found on the live cluster, when a nameserver
 * build that could not load left ns1 without DNS and nothing anywhere said why.
 *
 * Logged on change rather than every pass, since a part with no successful build fails every 30s
 * for as long as it stays that way: once when it starts failing, again if the error changes, and
 * once when it stops.
 */
function reportFailures(ctx: IServiceContext, failed: PartReconcileOutput['failed']): void {
    const failingNow = new Set<string>();
    for (const { partId, key, error } of failed) {
        failingNow.add(partId);
        if (lastFailure.get(partId)?.error === error) continue;
        lastFailure.set(partId, { key, error });
        ctx.logger.warn(`serve.part.reconcile: "${key}" failed: ${error}`);
    }
    for (const [partId, { key }] of lastFailure) {
        if (failingNow.has(partId)) continue;
        lastFailure.delete(partId);
        ctx.logger.info(`serve.part.reconcile: "${key}" no longer failing`);
    }
}
