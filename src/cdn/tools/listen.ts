import type { IServiceContext } from '@flybyme/mesh';

import { CdnGateway } from '../gateway.js';
import type { SiteListenInput, SiteListenOutput } from '../contracts/site.contract.js';

/**
 * The worked example of a `long-running` contract, and it is deliberately this short.
 *
 * Bind the port, hand teardown to `ctx.signal`, return. Because `serve.cdn.listen` declares
 * `concurrency: 'long-running'`, that signal is scoped to the *registration* rather than to this
 * call -- it stays live after the handler returns, and aborts exactly once, when the contract is
 * unregistered or the node stops. So the gateway outlives the call that started it and still gets
 * closed properly, with no lifecycle object anywhere: no `onStop`, no `{ domain, stop }`, nothing
 * holding the `http.Server` but this closure.
 */
export async function listen(params: SiteListenInput, ctx: IServiceContext): Promise<SiteListenOutput> {
    const gateway = new CdnGateway(ctx.broker);
    const boundTo = await gateway.start(params.port, params.host);

    ctx.signal.addEventListener('abort', () => {
        void gateway.stop().catch((err: unknown) => {
            ctx.logger.error('serve.cdn: gateway failed to close cleanly', err);
        });
    }, { once: true });

    // Already aborted means the node started shutting down between the bind and here -- close
    // immediately rather than leaking a listener that nothing will ever stop, since `addEventListener`
    // on an already-aborted signal never fires.
    if (ctx.signal.aborted) await gateway.stop();

    return { boundTo, nodeID: ctx.nodeID };
}
