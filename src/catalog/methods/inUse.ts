import { MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

/** What a CRUD delete hands its before-hook; the rest passes through untouched. */
export const deleteHookInput = z.object({ id: z.string() });

function inUse(message: string): MeshError {
    return new MeshError({ message, code: 'CONFLICT', status: 409 });
}

/**
 * serve.part.delete's check: a part meant to be running, or one a composition names (by id or key),
 * stays. Its builds stay too -- they are history, and an artifact names its part only by id.
 */
export async function refusePartInUse(ctx: IServiceContext, id: string): Promise<void> {
    const part = await ctx.db('serve.part').resolve({ id });
    if (part === undefined) return;

    if (part.desired === 'running') {
        throw inUse(`Part "${part.key}" is meant to be running: set its desired to stopped first.`);
    }

    const compositions = await ctx.db('serve.composition', { tenant_id: part.tenantId }).find({ query: {} });
    const naming = compositions.filter((composition) => {
        const refs = [composition.kernelPartKey, composition.theme, ...composition.drivers, ...composition.extensions, ...composition.applications, ...composition.services];

        return refs.some((ref) => ref === part.id || ref === part.key);
    });

    if (naming.length > 0) {
        throw inUse(`Part "${part.key}" is in composition ${naming.map((composition) => `"${composition.key}"`).join(', ')}: take it out first.`);
    }
}

/** serve.composition.delete's check: a composition a site still serves (site.application is its key) stays. */
export async function refuseCompositionInUse(ctx: IServiceContext, id: string): Promise<void> {
    const composition = await ctx.db('serve.composition').resolve({ id });
    if (composition === undefined) return;

    const sites = await ctx.db('serve.cdn', { tenant_id: composition.tenantId }).find({ query: { application: composition.key } });

    if (sites.length > 0) {
        throw inUse(`Composition "${composition.key}" is served by ${sites.map((site) => site.host).join(', ')}: delete or move those sites first.`);
    }
}
