/**
 * Reading the caller off a service context, in one place.
 *
 * Both `ApiService` and `McpService` build `meta` the same way — `{ user: { id, tenant_id, roles } }`
 * plus a top-level `tenant_id` — and the two constructions are already character-for-character
 * identical in two files (roadmap D10). Reading it back is the same hazard, so it is read here and
 * nowhere else.
 */

import { MeshError, type IServiceContext } from '@flybyme/mesh';

interface CallerMeta {
    readonly user?: { readonly id?: string; readonly tenant_id?: string; readonly roles?: readonly string[] };
    readonly tenant_id?: string;
    readonly unauthenticated?: boolean;
}

const metaOf = (ctx: IServiceContext): CallerMeta => (ctx.meta ?? {}) as CallerMeta;

/** The scope the gate resolved. Never a caller-supplied organization id. */
export function scopeOf(ctx: IServiceContext): string | undefined {
    const meta = metaOf(ctx);
    const scope = meta.user?.tenant_id ?? meta.tenant_id;
    return scope === undefined || scope === '' ? undefined : scope;
}

/**
 * Who is calling, or `undefined` for an anonymous one.
 *
 * Anonymous is a real answer and not an error: the gate decides whether it is good enough, and every
 * caller of this reads that decision itself rather than assuming.
 */
export function callerOf(
    ctx: IServiceContext,
): { readonly userId: string; readonly roles: readonly string[] } | undefined {
    const user = metaOf(ctx).user;
    if (user?.id === undefined || user.id === '') return undefined;
    return { userId: user.id, roles: user.roles ?? [] };
}

/**
 * One narrow structural retype, not `any`.
 *
 * `broker.call<K extends keyof IServiceToolRegistry>` cannot accept a name chosen at run time,
 * because a run-time `string` never narrows to one of its literal keys. `ApiService` and
 * `McpService` both have this shape and both solve it this way.
 */
export async function callBroker(
    ctx: IServiceContext,
    tool: string,
    params: unknown,
    options?: { readonly meta: Record<string, unknown> },
): Promise<unknown> {
    const broker = ctx.broker as unknown as {
        call(tool: string, params: unknown, options?: unknown): Promise<unknown>;
    } | undefined;
    if (broker === undefined) {
        throw new MeshError({ code: 'NO_BROKER', status: 503, message: 'approval has no broker.' });
    }
    return await broker.call(tool, params, options);
}
