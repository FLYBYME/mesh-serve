import type { IServiceBroker } from '@flybyme/mesh';

import {
    siteCrud,
    siteResolveHostContract,
    siteResolveByIdContract,
    siteDeployContract,
    siteListenContract,
} from './contracts/site.contract.js';
import { resolveHost } from './tools/resolveHost.js';
import { resolveById } from './tools/resolveById.js';
import { deploy } from './tools/deploy.js';
import { listen } from './tools/listen.js';

/**
 * serve.cdn, registered -- no `ServiceModule`, no class mounting tools.
 *
 * What used to be a 730-line class is now three things that don't need each other: the contracts
 * and their handlers (registered here), the HTTP gateway's own logic (`gateway.ts`, a plain class
 * with real private state and no contracts on it), and the listener's lifecycle
 * (`tools/listen.ts`, a `long-running` contract whose `ctx.signal` is the entire stop mechanism).
 *
 * The listener being a contract rather than a side effect of loading this part is what makes it
 * placeable: once the placement layer exists, deciding which node serves frontend traffic is
 * deciding where to call `serve.cdn.listen`. Until then `register` calls it locally, which is
 * exactly what `onStart` did -- just now reachable by something other than the loader.
 */
export const CDN_DOMAIN = 'serve.cdn';

export async function register(broker: IServiceBroker): Promise<string> {
    broker.registerCrud(siteCrud);
    broker.registerContract(siteResolveHostContract, resolveHost);
    broker.registerContract(siteResolveByIdContract, resolveById);
    broker.registerContract(siteDeployContract, deploy);
    broker.registerContract(siteListenContract, listen);

    await broker.call('serve.cdn.listen', {});

    return CDN_DOMAIN;
}
