import { onStop, type IServiceContext } from '@flybyme/mesh';

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

    // onStop, not a plain abort listener: the stop waits for the port to be let go, so the copy
    // that replaces this one never meets it there. Already aborted (the node stopping between the
    // bind and here), it closes at once. A failed close is the broker's to log.
    onStop(ctx.signal, () => gateway.stop());

    return { boundTo, nodeID: ctx.nodeID };
}
