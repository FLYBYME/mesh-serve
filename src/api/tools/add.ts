import { eventScope, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { AddInput, AddOutput } from '../contracts/expose.contract.js';
import { routeShape } from '../methods/route.js';

/**
 * A row with no role, on a contract that demands none, is callable by anyone -- and an anonymous
 * caller acts as the api's own tenant, so a tenant-scoped read then publishes that tenant's data.
 * That is how stored mail on api.surfdns.net became readable without signing in (2026-09-25): two
 * rows added with the role left off. Public is allowed; it just has to be said.
 */
function refuseAccidentallyPublic(input: AddInput, why: string): void {
    if (input.public === true) return;
    throw new MeshError({
        message: `"${input.contract}" would be callable by anyone, acting as this api's own tenant (${why}). Give it a role (e.g. role: "operator"), or pass public: true if that is really intended.`,
        code: 'BAD_REQUEST',
        status: 400,
    });
}

export async function add(
    input: AddInput,
    ctx: IServiceContext
): Promise<AddOutput> {
    if (input.role !== undefined && input.permission !== undefined) {
        throw new MeshError({ message: 'At most one of role or permission may be set.', code: 'BAD_REQUEST', status: 400 });
    }

    const ungated = input.role === undefined && input.permission === undefined;
    if (input.kind === 'event') {
        refuseUnstreamableEvent(input);
        if (ungated) refuseAccidentallyPublic(input, 'an event has no role of its own');
    } else {
        // This node's definition, or what the node that runs it advertises: the api publishes
        // contracts that run elsewhere (smtp.capture_list runs on surf, the api on edge1).
        const contract = ctx.broker.contractDeclaration(input.contract);
        if (contract === undefined || contract.visibility !== 'public') {
            throw new MeshError({ message: `"${input.contract}" is not a public contract.`, code: 'BAD_REQUEST', status: 400 });
        }
        if (ungated && contract.permissions.length === 0) refuseAccidentallyPublic(input, 'the contract demands no role itself');
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

    const existing = await ctx.db('serve.expose', meta).findOne({
        query: { apiId: input.apiId, contract: input.contract },
    });
    if (existing !== undefined) {
        throw new MeshError({ message: `"${input.contract}" is already exposed on this api.`, code: 'CONFLICT', status: 409 });
    }
    if (input.kind !== 'event') await refuseRouteCollision(input, meta, ctx);

    // Passing role/permission: undefined explicitly (rather than omitting the key) stores null,
    // which the schema's z.string().optional() fields then reject on the next read.
    const row = await ctx.db('serve.expose', meta).create({
        tenantId: api.tenantId,
        apiId: input.apiId,
        kind: input.kind,
        contract: input.contract,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.permission !== undefined ? { permission: input.permission } : {}),
    });

    ctx.logger.debug(`exposed "${input.contract}" on api "${input.apiId}"`, { role: input.role, permission: input.permission });

    return row;
}

/**
 * Two contracts on one route shape cannot both be reached: the gateway answers the request with
 * one of them and the other is silently unreachable. serve.repo and the gitserver's repo CRUD
 * were both `/repos` on api.surfdns.net, and `serve.repo.find` returned gitserver repos for days.
 */
async function refuseRouteCollision(
    input: AddInput,
    meta: { user: { id: string; tenant_id: string } },
    ctx: IServiceContext,
): Promise<void> {
    const contract = ctx.broker.contractDeclaration(input.contract);
    if (contract === undefined) return; // refused above; kept for the type
    const shape = routeShape(contract.rest.method, contract.rest.path);
    const rows = await ctx.db('serve.expose', meta).find({ query: { apiId: input.apiId } });
    for (const row of rows) {
        if (row.kind === 'event') continue;
        const other = ctx.broker.contractDeclaration(row.contract);
        if (other === undefined) continue;
        if (routeShape(other.rest.method, other.rest.path) === shape) {
            throw new MeshError({
                message: `"${input.contract}" and "${row.contract}" are both ${shape}; only one of them could ever be reached on this api. Give one of them a different path.`,
                code: 'CONFLICT',
                status: 409,
            });
        }
    }
}

/**
 * An event is exposed only if it can be delivered to somebody: an event this node has no definition
 * of, or whose definition cannot be narrowed to a subscriber, is refused here with the reason --
 * never accepted into a stream that then stays silent, the hardest failure to see.
 */
function refuseUnstreamableEvent(input: AddInput): void {
    if (input.permission !== undefined) {
        throw new MeshError({
            message: 'An event is gated by role only -- a permission names a contract to be permitted to call.',
            code: 'BAD_REQUEST',
            status: 400,
        });
    }
    const scope = eventScope(input.contract);
    if (scope === undefined) {
        throw new MeshError({
            message: `Cannot stream "${input.contract}": no module loaded on this node defines it.`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }
    if (scope !== 'global' && 'refusal' in scope) {
        throw new MeshError({ message: `Cannot stream "${input.contract}": ${scope.refusal}.`, code: 'BAD_REQUEST', status: 400 });
    }
}
