import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

/**
 * key is "org-slug/part-name" -- the org's own slug, not whatever the caller feels like typing,
 * so a part built by one org can't claim another org's namespace.
 *
 * Shared by serve.part's own create/update hooks (part.contract.ts), which is why it lives here
 * rather than on either of them.
 */
/**
 * The organization a create is for: the input's tenantId, else the caller's own, read as mesh's CRUD
 * scope reads it (meta.user.tenantId / tenant_id, then meta's). A create hook runs before mesh fills
 * the scope in, so a part created without naming its organization used to fail the hook's parse --
 * a bare 500 (found by the stand-up check, 2026-10-08).
 */
export function organizationOfCreate(input: { tenantId?: string }, ctx: IServiceContext): string {
    if (input.tenantId !== undefined) return input.tenantId;

    const meta: unknown = ctx.meta;
    const user: unknown = typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'user') : undefined;
    for (const [from, key] of [[user, 'tenantId'], [user, 'tenant_id'], [meta, 'tenantId'], [meta, 'tenant_id']] as const) {
        const value: unknown = typeof from === 'object' && from !== null ? Reflect.get(from, key) : undefined;
        if (typeof value === 'string' && value !== '') return value;
    }

    throw new MeshError({ message: 'Name the organization this part belongs to (tenantId).', code: 'BAD_REQUEST', status: 400 });
}

export async function validatePartKey(input: { key: string }, tenantId: string, ctx: IServiceContext): Promise<void> {
    const org = await ctx.db('identity.organization').resolve({ id: tenantId });
    if (org === undefined) {
        throw new MeshError({ message: `No organization "${tenantId}".`, code: 'NOT_FOUND', status: 404 });
    }
    const slash = input.key.indexOf('/');
    const prefix = slash === -1 ? undefined : input.key.slice(0, slash);
    const name = slash === -1 ? undefined : input.key.slice(slash + 1);
    if (prefix !== org.slug || name === undefined || name.length === 0) {
        throw new MeshError({
            message: `key must be "${org.slug}/<part-name>", got "${input.key}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }
}
