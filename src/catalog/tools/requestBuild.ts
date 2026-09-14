import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { RequestBuildInput, RequestBuildOutput } from '../contracts/artifact.contract.js';
import type { CatalogService } from '../catalog.service.js';

export async function requestBuild(
    this: CatalogService,
    input: RequestBuildInput,
    ctx: IServiceContext,
): Promise<RequestBuildOutput> {
    const part = await ctx.call('serve.part.resolve', { id: input.partId });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.partId}".`, code: 'NOT_FOUND', status: 404 });
    }

    if (input.drivers !== undefined && part.kind !== 'kernel') {
        throw new MeshError({
            message: `Only a kernel build takes drivers; "${input.partId}" is kind "${part.kind}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    if (input.drivers !== undefined) {
        for (const key of input.drivers) {
            const driver = await ctx.call('serve.part.find_one', { query: { key, tenantId: part.tenantId } });
            if (driver === undefined) {
                throw new MeshError({ message: `No driver part "${key}".`, code: 'NOT_FOUND', status: 404 });
            }
            if (driver.kind !== 'driver') {
                throw new MeshError({ message: `Part "${key}" is kind "${driver.kind}", not a driver.`, code: 'BAD_REQUEST', status: 400 });
            }
        }
    }

    return ctx.call('serve.artifact.create', {
        tenantId: part.tenantId,
        partId: part.id,
        ref: input.ref,
        drivers: input.drivers,
    });
}
