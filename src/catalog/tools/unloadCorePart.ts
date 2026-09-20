import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { CorePartUnloadInput, CorePartUnloadOutput } from '../contracts/corePart.contract.js';
import { corePartPath } from '../methods/corePartPath.js';
import { unloadAndEvictModule } from '../methods/loadModule.js';
import { clearServiceRunning, getRunningService } from '../methods/services.js';

/** Mirrors loadCorePart's key exactly -- `core:<name>`, never a real `serve.part` id. */
function runningKey(name: CorePartUnloadInput['name']): string {
    return `core:${name}`;
}

export async function unloadCorePart(input: CorePartUnloadInput, ctx: IServiceContext): Promise<CorePartUnloadOutput> {
    const key = runningKey(input.name);
    if (getRunningService(ctx.nodeID, key) === undefined) {
        throw new MeshError({ message: `"${input.name}" is not running on this node.`, code: 'NOT_FOUND', status: 404 });
    }

    const { domains, contracts, evicted } = await unloadAndEvictModule(ctx, corePartPath(input.name));
    clearServiceRunning(ctx.nodeID, key);

    ctx.logger.info(`Unloaded "${input.name}" from ${ctx.nodeID}: ${String(contracts)} contracts, module ${evicted ? 'evicted' : 'retained'}.`);
    return { domains, contracts, evicted, nodeID: ctx.nodeID };
}
