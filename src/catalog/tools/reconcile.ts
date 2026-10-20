import { Database } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { partCrud } from '../contracts/part.contract.js';
import type { Part } from '../contracts/part.contract.js';
import { artifactCrud } from '../contracts/artifact.contract.js';
import type { PartReconcileOutput } from '../contracts/supervisor.contract.js';
import { labelHas, nodeMatchesSelector, nodesForSelector, resolveNodeSelector } from '../methods/resolveNode.js';

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

    // A build asked to pin itself (`requestBuild --pin`) is pinned here too, not only by the
    // builder: the builder marks the build successful before it pins, and on a flaky link the pin's
    // calls could fail after that -- compute's build of 2026-09-27 stayed successful and unpinned.
    // Only forward: never onto a build older than the one already pinned.
    const artifacts = db.repo(artifactCrud.get.outputSchema, 'serve.artifact');
    for (const part of services) {
        const requested = (await artifacts.find({ query: { partId: part.id, status: 'success', pinOnSuccess: true } }))
            .map((raw) => artifactCrud.get.outputSchema.parse(raw))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (requested === undefined || requested.id === part.artifactId) continue;
        const pinned = part.artifactId !== undefined
            ? (await artifacts.find({ query: { id: part.artifactId } })).map((raw) => artifactCrud.get.outputSchema.parse(raw))[0]
            : undefined;
        if (pinned !== undefined && new Date(pinned.createdAt).getTime() >= new Date(requested.createdAt).getTime()) continue;
        await ctx.call('serve.part.update', { id: part.id, artifactId: requested.id }, { meta: { tenant_id: part.tenantId } });
        part.artifactId = requested.id;
        ctx.logger.info(`serve.part.reconcile: pinned "${part.key}" to ${requested.id}, the build requested with --pin`);
    }

    // Observed: ask every node what it is running. A node that has died is absent from the
    // registry and simply is not asked, which is exactly the signal we want -- there is no stale
    // record of it claiming to still host anything.
    const nodes = ctx.broker.registry.getNodes();
    const observed = new Map<string, Observed[]>(); // by partId: every node that runs it
    const unanswered: string[] = [];

    for (const node of nodes) {
        try {
            const report = await ctx.call('serve.part.runningHere', {}, { nodeID: node.nodeID });
            for (const service of report.services) {
                const runs = observed.get(service.partId) ?? [];
                runs.push({ nodeID: report.nodeID, artifactId: service.artifactId });
                observed.set(service.partId, runs);
            }
        } catch (err) {
            // A builder hosts no parts, so its silence cannot mean it runs one: counted, a laptop
            // builder on a flaky link held back every unseen part's start (2026-09-27).
            if (labelHas(node.metadata?.role, 'builder')) {
                ctx.logger.debug(`serve.part.reconcile: builder ${node.nodeID} did not report; it hosts no parts`);
                continue;
            }
            // A node that cannot answer is one we cannot reason about -- it may be running anything.
            // Its report is missing, so every part it holds looks "not running" below; `unanswered`
            // is what stops that from reading as a reason to start them (see the start branch).
            unanswered.push(node.nodeID);
            ctx.logger.warn(`serve.part.reconcile: ${node.nodeID} did not report what it is running; nothing unseen is started this pass`, err);
        }
    }

    const out: PartReconcileOutput = { started: [], stopped: [], redeployed: [], failed: [] };
    const { started, stopped, failed } = out;

    for (const part of services) {
        if (part.placement === 'every') {
            await reconcileEvery(ctx, part, observed.get(part.id) ?? [], unanswered, out);
            continue;
        }

        const observedRun = observed.get(part.id)?.[0];
        let runningOn = observedRun?.nodeID;

        // Running on a node its nodeSelector no longer names: the pin moved (a part moved to a pod
        // node, a role moved to another machine). Stop it there, then fall through and start it
        // where it now belongs in this same pass -- a pass apart, ns2 answered no DNS for 33 s.
        // Only when that place is online -- otherwise a stop would leave it running nowhere.
        // Before this, a changed selector was ignored while the part kept running (nameserver-ns2,
        // moving to its pod node, 2026-09-27).
        if (
            part.desired === 'running' && runningOn !== undefined && part.nodeSelector !== undefined
            && !nodeMatchesSelector(ctx.broker.registry, runningOn, part.nodeSelector)
            && resolveNodeSelector(ctx.broker.registry, part.nodeSelector) !== undefined
        ) {
            try {
                await ctx.call('serve.part.stop', { id: part.id }, { nodeID: runningOn, meta: { tenant_id: part.tenantId } });
                stopped.push({ partId: part.id, key: part.key, nodeID: runningOn });
                ctx.logger.info(`serve.part.reconcile: stopped "${part.key}" on ${runningOn}: its nodeSelector "${part.nodeSelector}" now names another node`);
            } catch (err) {
                failed.push({ partId: part.id, key: part.key, error: err instanceof Error ? err.message : String(err) });
                continue;
            }
            runningOn = undefined;
        }

        // Running, but not the build it is pinned to: the pin moved (a deploy or a rollback). Restart
        // it in place, on the node it already runs on -- placement is not what changed. Only a pinned
        // part is compared; an unpinned one has no declared build to be out of date against.
        if (
            part.desired === 'running' && runningOn !== undefined && observedRun !== undefined
            && part.artifactId !== undefined && observedRun.artifactId !== part.artifactId
        ) {
            await redeploy(ctx, part, part.artifactId, observedRun, out);
            continue;
        }

        // Only a silent node the part could be on holds it back: its nodeSelector's match, or any
        // node for a part placed automatically. One dead pod node held back every part in the
        // cluster (2026-09-27). A pinned part runs only where its selector matches -- the move
        // branch above stops it elsewhere, and only once its new node answers.
        const selector = part.nodeSelector;
        const couldHold = selector === undefined
            ? unanswered
            : unanswered.filter((nodeID) => nodeMatchesSelector(ctx.broker.registry, nodeID, selector));
        if (part.desired === 'running' && runningOn === undefined && couldHold.length > 0) {
            // Not seen running -- but a node that did not answer may be running it. Starting it
            // would load a second copy (elsewhere) or pile a start onto a node already struggling
            // (on it): skipping it was the intent, and a report with a missing node used to be read
            // as "running nothing" (surf tried to start edge1's parts on edge1, 2026-09-26).
            failed.push({ partId: part.id, key: part.key, error: `not started: ${couldHold.join(', ')} did not answer, and may already be running it` });
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

    return out;
}

/** One node's report of running a part, and which build. */
interface Observed {
    nodeID: string;
    artifactId?: string | undefined;
}

/**
 * Running, but not the build it is pinned to: restarts it on the pinned build in place, on the node
 * it already runs on.
 */
async function redeploy(ctx: IServiceContext, part: Part, artifactId: string, run: Observed, out: PartReconcileOutput): Promise<void> {
    const scoped = { nodeID: run.nodeID, meta: { tenant_id: part.tenantId } };
    try {
        // The new build onto that node first (from a node, the database, or rebuilt): a
        // redeploy never stops the old build before the new one is there. It used to stop
        // first and fetch in the start -- a build nothing could give left the part down.
        const pinned = await ctx.call('serve.artifact.get', { id: artifactId }, { meta: scoped.meta });
        if (pinned.hash === undefined) throw new Error(`pinned build ${artifactId} has no hash (status ${pinned.status}); the old build keeps running`);
        await ctx.call('serve.artifact.pull', { artifactHash: pinned.hash }, scoped).catch((err: unknown) => {
            throw new Error(`the new build is not available on ${run.nodeID} (${err instanceof Error ? err.message : String(err)}); the old build keeps running`);
        });
        await ctx.call('serve.part.stop', { id: part.id }, scoped);
        // If this start fails the part is now simply not running, and the next pass's
        // not-running branch retries it like any other missing service.
        await ctx.call('serve.part.start', { id: part.id }, scoped);
        out.redeployed.push({
            partId: part.id,
            key: part.key,
            nodeID: run.nodeID,
            ...(run.artifactId !== undefined ? { from: run.artifactId } : {}),
            to: artifactId,
        });
        ctx.logger.info(`serve.part.reconcile: redeployed "${part.key}" on ${run.nodeID}: ${run.artifactId ?? '(unknown)'} -> ${artifactId}`);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        out.failed.push({ partId: part.id, key: part.key, nodeID: run.nodeID, error });
    }
}

/**
 * A part placed on every node its nodeSelector matches (placement "every"): one copy per match --
 * dns, proxy and smtp on each edge machine, each answering on its own address. Each node is its own
 * small reconcile: started where it is missing, redeployed where it runs another build, stopped
 * where the selector no longer names it. A silent node holds back only its own copy, never the
 * others.
 */
async function reconcileEvery(ctx: IServiceContext, part: Part, runs: Observed[], unanswered: string[], out: PartReconcileOutput): Promise<void> {
    const scoped = (nodeID: string) => ({ nodeID, meta: { tenant_id: part.tenantId } });

    const stop = async (nodeID: string, why: string): Promise<void> => {
        try {
            await ctx.call('serve.part.stop', { id: part.id }, scoped(nodeID));
            out.stopped.push({ partId: part.id, key: part.key, nodeID });
            ctx.logger.info(`serve.part.reconcile: stopped "${part.key}" on ${nodeID}: ${why}`);
        } catch (err) {
            out.failed.push({ partId: part.id, key: part.key, nodeID, error: err instanceof Error ? err.message : String(err) });
        }
    };

    if (part.desired === 'stopped') {
        for (const run of runs) await stop(run.nodeID, 'no longer desired');
        return;
    }

    const selector = part.nodeSelector;
    if (selector === undefined) {
        out.failed.push({ partId: part.id, key: part.key, error: 'placement "every" needs a nodeSelector: which nodes is every?' });
        return;
    }

    const targets = nodesForSelector(ctx.broker.registry, selector).map((node) => node.nodeID);

    // Off the selector: a node lost its label. Stopped only while a copy still runs or can run
    // somewhere it belongs, so a mistyped selector never takes the last copy down.
    for (const run of runs) {
        if (targets.includes(run.nodeID) || targets.length === 0) continue;
        await stop(run.nodeID, `its nodeSelector "${selector}" no longer names this node`);
    }

    for (const nodeID of targets) {
        const run = runs.find((r) => r.nodeID === nodeID);

        if (run !== undefined) {
            if (part.artifactId !== undefined && run.artifactId !== part.artifactId) await redeploy(ctx, part, part.artifactId, run, out);
            continue;
        }

        if (unanswered.includes(nodeID)) {
            out.failed.push({ partId: part.id, key: part.key, nodeID, error: `not started on ${nodeID}: it did not answer, and may already be running it` });
            continue;
        }

        try {
            await ctx.call('serve.part.start', { id: part.id }, scoped(nodeID));
            out.started.push({ partId: part.id, key: part.key, nodeID });
            ctx.logger.info(`serve.part.reconcile: started "${part.key}" on ${nodeID}`);
        } catch (err) {
            out.failed.push({ partId: part.id, key: part.key, nodeID, error: err instanceof Error ? err.message : String(err) });
        }
    }
}

/**
 * The last error logged for each part that is failing, by partId -- and node, for a part on every
 * match, whose copies fail apart -- see reportFailures.
 */
const lastFailure = new Map<string, { key: string; where: string; error: string }>();

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
    for (const { partId, key, nodeID, error } of failed) {
        const id = nodeID === undefined ? partId : `${partId}@${nodeID}`;
        const where = nodeID === undefined ? '' : ` on ${nodeID}`;
        failingNow.add(id);
        if (lastFailure.get(id)?.error === error) continue;
        lastFailure.set(id, { key, where, error });
        ctx.logger.warn(`serve.part.reconcile: "${key}"${where} failed: ${error}`);
    }
    for (const [id, { key, where }] of lastFailure) {
        if (failingNow.has(id)) continue;
        lastFailure.delete(id);
        ctx.logger.info(`serve.part.reconcile: "${key}"${where} no longer failing`);
    }
}
