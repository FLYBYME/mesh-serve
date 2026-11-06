import { onStop, type IServiceContext } from '@flybyme/mesh';

import { ApiGateway } from '../gateway.js';
import type { ApiListenInput, ApiListenOutput } from '../contracts/api.contract.js';

/**
 * Bind the port, hand teardown to `ctx.signal`, return.
 *
 * `serve.api.listen` declares `concurrency: 'long-running'`, so that signal is scoped to the
 * *registration* rather than to this call -- it stays live after the handler returns and aborts
 * exactly once, when the contract is unregistered or the node stops. The gateway therefore
 * outlives the call that started it and still gets closed properly, with no lifecycle object:
 * no `onStop`, no `{ domain, stop }`, nothing holding the `http.Server` but this closure.
 */
export async function listen(params: ApiListenInput, ctx: IServiceContext): Promise<ApiListenOutput> {
    const gateway = new ApiGateway(ctx.broker);
    const boundTo = await gateway.start(params.port, params.host);

    // onStop, not a plain abort listener: the stop waits for the port to be let go, so the copy
    // that replaces this one never meets it there. Already aborted (the node stopping between the
    // bind and here), it closes at once. A failed close is the broker's to log.
    onStop(ctx.signal, () => gateway.stop());

    return { boundTo, nodeID: ctx.nodeID };
}
