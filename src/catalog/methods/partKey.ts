import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

/**
 * key is "org-slug/part-name" -- the org's own slug, not whatever the caller feels like typing,
 * so a part built by one org can't claim another org's namespace.
 *
 * Shared by serve.part's own create/update hooks (part.contract.ts), which is why it lives here
 * rather than on either of them.
 */
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
