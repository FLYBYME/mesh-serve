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

    // Evict where we can. A part loaded through the manifest shape is tracked by module path and
    // comes apart cleanly; one that mounted a whole ServiceModule is torn down by
    // unregisterModule instead. Trying eviction first and falling back keeps both working without
    // this having to know which era the part belongs to -- the same principle the loader follows.
    if (running.modulePath !== undefined && isPartLoaded(ctx.nodeID, running.modulePath)) {
        await unloadAndEvictModule(ctx, running.modulePath);
    } else {
        await ctx.broker.unregisterModule(running.mountKey);
    }
    clearServiceRunning(ctx.nodeID, part.id);

    return { stopped: true };
}
