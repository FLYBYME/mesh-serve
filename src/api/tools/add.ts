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
    const api = await ctx.call('serve.api.resolveById', { id: input.apiId });

    // Nested under `user`, not a flat `{ tenant_id }` -- ServiceBroker.internalCall shallow-merges
    // `{...activeCtx.meta, ...options.meta}`, and this call runs inside the ambient ctx of the
    // *caller's own* request (an authenticated operator hitting this through their own api).
    // resolveCallerScope checks `meta.user` before a flat `meta.tenant_id`, so a flat override here
    // was silently shadowed by the caller's own `user.tenant_id` every time the caller had one --
    // exposing a contract on another tenant's api always landed the row in the caller's own tenant
    // instead. A whole `user` key wins over the shallow merge because it replaces the object outright;
    // `id` carries forward from the caller's own ambient meta since it is still who did this.
    const meta = { user: { id: ctx.meta?.user?.id ?? '', tenant_id: api.tenantId } };

    const existing = await ctx.call('serve.expose.find_one', {
        query: { apiId: input.apiId, contract: input.contract },
    }, { meta });
    if (existing !== undefined) {
        throw new MeshError({ message: `"${input.contract}" is already exposed on this api.`, code: 'CONFLICT', status: 409 });
    }

    // Passing role/permission: undefined explicitly (rather than omitting the key) stores null,
    // which the schema's z.string().optional() fields then reject on the next read.
    const row = await ctx.call('serve.expose.create', {
        tenantId: api.tenantId,
        apiId: input.apiId,
        contract: input.contract,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.permission !== undefined ? { permission: input.permission } : {}),
    }, { meta });

    ctx.logger.debug(`exposed "${input.contract}" on api "${input.apiId}"`, { role: input.role, permission: input.permission });

    return row;
}
