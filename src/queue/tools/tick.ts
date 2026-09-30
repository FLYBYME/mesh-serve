import type { IServiceContext, IServiceToolRegistry } from '@flybyme/mesh';

import { QUEUE_MAX_CONCURRENCY, type QueueJob, type QueueTickOutput } from '../contracts/queue.contract.js';

/**
 * Jobs this node is currently running.
 *
 * Module-level rather than a class field, and that is the whole substance of what `ServiceModule`
 * was providing here: a place to hang state that outlives one call. A precompiled part is loaded
 * once per node (`loadModule.ts` -> `require()`), so module scope has exactly the lifetime the
 * class instance had, without a class. It is per-node state, never shared -- the cluster-wide
 * invariant ("one node claims a given row") lives in `claim`'s leaderScoped + withLock, not here.
 */
const inFlight = new Set<string>();

/**
 * Event-driven, with the timer as a safety net (2026-09-30).
 *
 * The tick ran every 500 ms on every queue node, and each pass made a `claim` call funnelled onto
 * the leader -- 2 claims a second with nothing queued, seen in the builder's own metrics the day
 * they were turned on. Now a pass runs when there can be work: a job was created
 * (`serve.queue.created`, from any node), a job here finished (a slot is free), a retry's backoff
 * came due. The interval (QUEUE_TICK_MS, 60 s) remains only for what no event announces: a lease
 * abandoned by a node that died mid-job.
 *
 * Every trigger goes through `pump`: one pass at a time on this node, and a trigger during a pass
 * runs exactly one more after it -- a burst of creates costs one extra pass, not one each.
 */
interface PumpState {
    passing: Promise<QueueTickOutput> | undefined;
    again: boolean;
    listening: boolean;
}

/** Per broker: one process normally holds one node, but a test runs several side by side. */
const pumps = new WeakMap<object, PumpState>();

function stateOf(ctx: IServiceContext): PumpState {
    let state = pumps.get(ctx.broker);
    if (state === undefined) {
        state = { passing: undefined, again: false, listening: false };
        pumps.set(ctx.broker, state);
    }
    return state;
}

function pump(ctx: IServiceContext): Promise<QueueTickOutput> {
    const state = stateOf(ctx);
    if (state.passing !== undefined) {
        state.again = true;
        return state.passing;
    }
    const running = (async () => {
        let last: QueueTickOutput = { started: 0, inFlight: inFlight.size };
        do {
            state.again = false;
            last = await pass(ctx);
        } while (state.again && !ctx.signal.aborted);
        return last;
    })().finally(() => {
        state.passing = undefined;
    });
    state.passing = running;
    return running;
}

/** Runs `pump` without waiting, logging what it throws: for triggers that have nobody to answer. */
function wake(ctx: IServiceContext): void {
    if (ctx.signal.aborted) return;
    pump(ctx).catch((err: unknown) => ctx.logger.error('serve.queue: a pass threw', err));
}

/** Subscribes once per load; the part's unload (or the node's stop) aborts `ctx.signal`. */
function listen(ctx: IServiceContext): void {
    const state = stateOf(ctx);
    if (state.listening || ctx.signal.aborted) return;
    const off = ctx.broker.subscribe('serve.queue.created', () => wake(ctx));
    state.listening = true;
    ctx.signal.addEventListener('abort', () => {
        off();
        state.listening = false;
    }, { once: true });
}

/** The interval's pass, and the first one after a load: starts listening, then pumps. */
export async function tick(_params: Record<string, never>, ctx: IServiceContext): Promise<QueueTickOutput> {
    listen(ctx);
    return pump(ctx);
}

/**
 * One pass of the queue loop: claim up to the concurrency limit and start what it claims.
 *
 * Claims are sequential within a pass (each is a fast dispatched call that funnels onto the
 * leader), while the work they start runs concurrently -- `run()` is deliberately not awaited. The
 * predecessor's real bug was never the tick rate, it was that only one job ever ran at a time.
 */
async function pass(ctx: IServiceContext): Promise<QueueTickOutput> {
    let started = 0;

    while (inFlight.size < QUEUE_MAX_CONCURRENCY) {
        // The contract is interval-scoped, so this signal aborts when the part is unregistered or
        // the node stops -- not between ticks. Checking it mid-loop stops a shutting-down node from
        // claiming work it will never run, which would leave rows at 'running' until their lease
        // expired.
        if (ctx.signal.aborted) break;

        const job = await ctx.call('serve.queue.claim', {});
        if (job === undefined) break;

        started += 1;
        inFlight.add(job.id);
        run(job, ctx)
            .catch((err: unknown) => {
                ctx.logger.error(`serve.queue job ${job.id} threw outside its own handling`, err);
            })
            .finally(() => {
                inFlight.delete(job.id);
                // A slot is free: whatever waited on the limit can start now.
                wake(ctx);
            });
    }

    return { started, inFlight: inFlight.size };
}

/**
 * Runs one claimed job under the original caller's identity, then records the outcome.
 */
async function run(job: QueueJob, ctx: IServiceContext): Promise<void> {
    // A system job (no requestedBy -- catalog's build dispatch, most concretely) runs with bare
    // tenant scope and no caller, the same convention buildArtifact's own internal calls already
    // use. resolveCallerScope falls back to meta.tenant_id when meta.user is absent, so this is not
    // a degraded case, just the correct one for a job nothing signed in ever asked for.
    const meta = job.requestedBy !== undefined
        ? { user: { id: job.requestedBy.userId, tenant_id: job.tenantId } }
        : { tenant_id: job.tenantId };
    const tenantMeta = { meta: { tenant_id: job.tenantId } };
    ctx.logger.debug(`serve.queue: running ${job.id} (${job.contract}), attempt ${job.attempts}/${job.maxAttempts}`);

    try {
        await ctx.call(
            job.contract as keyof IServiceToolRegistry,
            job.payload as never,
            { meta, timeout: job.timeoutMs },
        );
        await ctx.call('serve.queue.update', { id: job.id, status: 'completed' }, tenantMeta);
        ctx.logger.debug(`serve.queue: completed ${job.id}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (job.attempts >= job.maxAttempts) {
            await ctx.call('serve.queue.update', {
                id: job.id, status: 'failed', error: message,
            }, tenantMeta);
            ctx.logger.error(`serve.queue: ${job.id} failed permanently after ${job.attempts} attempts`, err);
            return;
        }

        // Exponential-ish backoff, capped at a minute -- the predecessor retried a failed job on
        // its very next tick, forever, which is a tight loop against whatever just failed (a down
        // provider, most concretely) rather than a retry policy.
        const backoffMs = Math.min(1000 * job.attempts ** 2, 60_000);
        await ctx.call('serve.queue.update', {
            id: job.id, status: 'pending', error: message,
            nextAttemptAt: new Date(Date.now() + backoffMs),
        }, tenantMeta);
        ctx.logger.debug(`serve.queue: ${job.id} failed, retrying in ${backoffMs}ms`);
        // The retry's own wake-up, rather than a timer asking every 500 ms whether it is due yet.
        const retry = setTimeout(() => wake(ctx), backoffMs + 50);
        retry.unref();
    }
}
