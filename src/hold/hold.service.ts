import type { IServiceBroker } from '@flybyme/mesh';

import { holdCrud, holdDecideContract } from './contracts/hold.contract.js';
import { decide } from './tools/decide.js';

export const HOLD_DOMAIN = 'serve.hold';

/**
 * The first service migrated off `ServiceModule` entirely -- no class, no `mountCrud`/`mountTool`,
 * nothing to instantiate. `serve.hold` was the natural first one: the audit in
 * docs/CONTRACT_DRIVEN_PLACEMENT.md found it holds zero instance state, so the class was only ever
 * where the code happened to live, never something doing real work.
 *
 * `register` is the standalone part shape `catalog/methods/loadModule.ts` looks for, so this loads
 * through exactly the same `serve.corePart.load` path every other core part does -- the loader
 * doesn't know or care which shape a given part uses, which is what makes migrating them one at a
 * time possible.
 */
export function register(broker: IServiceBroker): string {
    broker.registerCrud(holdCrud);
    broker.registerContract(holdDecideContract, decide);
    return HOLD_DOMAIN;
}
