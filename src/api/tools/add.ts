import { globalContractRegistry, isPublicContract, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { AddInput, AddOutput } from '../contracts/expose.contract.js';
import type { ApiService } from '../api.service.js';

export async function add(
    this: ApiService,
    input: AddInput,
    ctx: IServiceContext
): Promise<AddOutput> {
    if (input.role !== undefined && input.permission !== undefined) {
        throw new MeshError({ message: 'At most one of role or permission may be set.', code: 'BAD_REQUEST', status: 400 });
    }

    const contract = globalContractRegistry.get(input.contract);
    if (contract === undefined || !isPublicContract(contract)) {
        throw new MeshError({ message: `"${input.contract}" is not a public contract.`, code: 'BAD_REQUEST', status: 400 });
    }

    // The target api can belong to any tenant, unrelated to the caller's own, so its tenant isn't
    // known yet -- serve.api.resolveById is api's own anonymous-lookup tool for exactly this, same
    // pattern as serve.cdn.resolveById.
    const api = await ctx.broker.call('serve.api.resolveById', { id: input.apiId });

    const meta = { tenant_id: api.tenantId };

    const existing = await ctx.broker.call('serve.expose.find_one', {
        query: { apiId: input.apiId, contract: input.contract },
    }, { meta });
    if (existing !== undefined) {
        throw new MeshError({ message: `"${input.contract}" is already exposed on this api.`, code: 'CONFLICT', status: 409 });
    }

    // Passing role/permission: undefined explicitly (rather than omitting the key) stores null,
    // which the schema's z.string().optional() fields then reject on the next read.
    const row = await ctx.broker.call('serve.expose.create', {
        tenantId: api.tenantId,
        apiId: input.apiId,
        contract: input.contract,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.permission !== undefined ? { permission: input.permission } : {}),
    }, { meta });

    ctx.logger.debug(`exposed "${input.contract}" on api "${input.apiId}"`, { role: input.role, permission: input.permission });

    return row;
}
