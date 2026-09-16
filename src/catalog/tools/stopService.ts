import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { PartStopInput, PartStopOutput } from '../contracts/part.contract.js';
import { clearServiceRunning, getRunningService } from '../methods/services.js';

export async function stopService(input: PartStopInput, ctx: IServiceContext): Promise<PartStopOutput> {
    const part = await ctx.call('serve.part.resolve', { id: input.id });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }

    const running = getRunningService(part.id);
    if (running === undefined) {
        throw new MeshError({ message: `"${part.key}" is not running on this node.`, code: 'NOT_FOUND', status: 404 });
    }

    await ctx.broker.unregisterModule(running.mountKey);
    clearServiceRunning(part.id);

    return { stopped: true };
}
