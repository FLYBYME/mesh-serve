import { defineContract, z } from '@flybyme/mesh';

/**
 * The supervisor: desired state, observed state, and the loop that closes the gap.
 *
 * `serve.part.start` is imperative -- it runs a service on the node the call reaches, once. Nothing
 * records that it *should* still be running, so when that node dies the service simply stops
 * existing and nothing anywhere notices. That is the gap these two contracts close.
 *
 * Desired state is `serve.part.desired`, set like any other field (`serve.part.update`). Observed
 * state is asked of each node directly rather than stored: a node that is gone is absent from the
 * registry, where a database flag would survive the crash that made it stale -- the same reasoning
 * `catalog/methods/services.ts` already gives for keeping that registry in memory.
 */

export const partRunningHereOutputSchema = z.object({
    nodeID: z.string(),
    services: z.array(z.object({
        partId: z.string().describe('The serve.part this node has loaded'),
        domain: z.string().describe('The mount key it registered under here'),
    })).describe('Every kind: "service" part this node is currently running'),
}).describe('What one node is actually running');

/**
 * What *this* node is running, answered from its own in-memory registry.
 *
 * Addressed with an explicit `nodeID` by the reconciler, which is the only reason it is a contract
 * rather than a function: the answer is different on every node, and the whole point is to ask
 * each one.
 */
export const partRunningHereContract = defineContract({
    domain: 'serve.part',
    action: 'runningHere',
    description: 'Which kind: "service" parts this node is currently running.',
    inputSchema: z.object({}),
    outputSchema: partRunningHereOutputSchema,
    rest: { method: 'GET', path: '/parts/running-here' },
    dependencies: [],
    filePath: 'src/catalog/tools/runningHere.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.nodeID}: ${o.services.length === 0 ? 'nothing' : o.services.map((s) => s.domain).join(', ')}`,
});

export type PartRunningHereOutput = z.infer<typeof partRunningHereContract.outputSchema>;

export const partReconcileOutputSchema = z.object({
    started: z.array(z.object({ partId: z.string(), key: z.string(), nodeID: z.string() }))
        .describe('Services that should have been running somewhere and were not'),
    stopped: z.array(z.object({ partId: z.string(), key: z.string(), nodeID: z.string() }))
        .describe('Services still running that are no longer desired'),
    failed: z.array(z.object({ partId: z.string(), key: z.string(), error: z.string() }))
        .describe('Services that could not be started -- reported rather than thrown, so one bad part cannot stall the rest'),
}).describe('What one reconcile pass changed');

/**
 * Compares desired against observed and closes the gap, once per tick.
 *
 * `leaderScoped`, and it genuinely has to be: two nodes reconciling concurrently would both see a
 * service as missing and both start it. `startIntervalContract` drops the tick on a non-leader, so
 * every node loads this and only one acts -- and leadership moving is picked up on the next tick
 * without anything watching for it.
 *
 * Placement is deterministic rather than balanced: the target node is `leaderFor(part.key)`, so
 * every pass agrees on where a given service belongs without needing to remember a previous
 * decision. A real scheduler would weigh capacity; this only has to be stable and to converge.
 */
export const partReconcileContract = defineContract({
    domain: 'serve.part',
    action: 'reconcile',
    description: 'Start services that should be running and are not, and stop those no longer desired.',
    inputSchema: z.object({}),
    outputSchema: partReconcileOutputSchema,
    rest: { method: 'POST', path: '/parts/reconcile' },
    destructive: true,
    leaderScoped: true,
    dependencies: ['serve.part'],
    filePath: 'src/catalog/tools/reconcile.ts',
    concurrency: 'interval',
    intervalMs: Number(process.env.SUPERVISOR_INTERVAL_MS ?? 30_000),
    permissions: ['operator'],
    print: (o) => `started ${o.started.length}, stopped ${o.stopped.length}, failed ${o.failed.length}`,
});

export type PartReconcileOutput = z.infer<typeof partReconcileContract.outputSchema>;
