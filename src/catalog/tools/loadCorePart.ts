import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { CorePartLoadInput, CorePartLoadOutput } from '../contracts/corePart.contract.js';
import { corePartPath } from '../methods/corePartPath.js';
import { loadAndRegisterModule } from '../methods/loadModule.js';
import { getRunningService, markServiceRunning } from '../methods/services.js';

/** Same in-memory tracking `startService.ts` uses for catalog-managed parts, keyed distinctly
 *  (`core:<name>`, never a real `serve.part` id) so the two can never collide. */
function runningKey(name: CorePartLoadInput['name']): string {
    return `core:${name}`;
}

export async function loadCorePart(input: CorePartLoadInput, ctx: IServiceContext): Promise<CorePartLoadOutput> {
    const key = runningKey(input.name);
    if (getRunningService(key) !== undefined) {
        throw new MeshError({ message: `"${input.name}" is already running on this node.`, code: 'BAD_REQUEST', status: 400 });
    }

    const { domain, nodeID } = await loadAndRegisterModule(ctx, corePartPath(input.name));
    markServiceRunning(key, domain);

    return { domain, nodeID };
}
