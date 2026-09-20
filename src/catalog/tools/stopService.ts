import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { PartStopInput, PartStopOutput } from '../contracts/part.contract.js';
import { clearServiceRunning, getRunningService } from '../methods/services.js';
import { isPartLoaded, unloadAndEvictModule } from '../methods/loadModule.js';

export async function stopService(input: PartStopInput, ctx: IServiceContext): Promise<PartStopOutput> {
    const part = await ctx.db('serve.part').resolve({ id: input.id });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }

    const running = getRunningService(ctx.nodeID, part.id);
    if (running === undefined) {
        throw new MeshError({ message: `"${part.key}" is not running on this node.`, code: 'NOT_FOUND', status: 404 });
    }

    // A part that went through `loadDomain` is tracked by module path, and unloading it unmounts
    // every contract it mounted (which is what stops a listener or a timer) and drops its module.
    // A `register`-shaped part mounts whatever it likes without recording it, so all that can be
    // done for one is run its own `stop` and evict the module -- `unloadAndEvictModule` handles
    // both, from the record `loadAndRegisterModule` wrote at load.
    //
    // No modulePath means nothing on this node ever loaded it, which `getRunningService` should
    // already have ruled out -- say so rather than clearing the entry and reporting success.
    if (running.modulePath === undefined || !isPartLoaded(ctx.nodeID, running.modulePath)) {
        throw new MeshError({
            message: `"${part.key}" is marked running on this node but nothing is loaded for it -- refusing to report a stop that did not happen.`,
            code: 'CONFLICT',
            status: 409,
        });
    }

    await unloadAndEvictModule(ctx, running.modulePath);
    clearServiceRunning(ctx.nodeID, part.id);

    return { stopped: true };
}
