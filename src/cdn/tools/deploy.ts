import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { DeployInput, DeployOutput } from '../contracts/site.contract.js';
import type { CdnService } from '../cdn.service.js';

/**
 * Points a site at a release, after checking the release actually belongs to it: same tenant, and
 * composing the same application the site was declared to serve (composition.key === site.application
 * -- the link the schema describes but nothing before this enforced).
 *
 * Also the one place serve.want gets real content: every part a deployed release pins carries its
 * own resolved `wants` (from mesh.wants.json, set at build time), and the union of those becomes
 * this site's want rows -- added, removed, or left alone to match exactly what the newly deployed
 * code actually calls, not what some earlier release happened to call.
 */
export async function deploy(this: CdnService, input: DeployInput, ctx: IServiceContext): Promise<DeployOutput> {
    const site = await ctx.broker.call('serve.cdn.resolveById', { id: input.siteId });
    const meta = { tenant_id: site.tenantId };

    const release = await ctx.broker.call('serve.release.getRelease', { hash: input.releaseHash });
    if (release.tenantId !== site.tenantId) {
        throw new MeshError({
            message: `Release "${input.releaseHash}" belongs to a different organization than site "${input.siteId}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const composition = await ctx.broker.call('serve.composition.resolve', { id: release.compositionId }, { meta });
    if (composition === undefined) {
        throw new MeshError({ message: `Release "${input.releaseHash}" has no composition.`, code: 'NOT_FOUND', status: 404 });
    }
    if (composition.key !== site.application) {
        throw new MeshError({
            message: `Release "${input.releaseHash}" composes "${composition.key}", but site "${input.siteId}" serves "${site.application}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const wanted = new Set<string>();
    for (const part of release.parts) {
        const resolved = await ctx.broker.call('serve.part.find_one', { query: { key: part.partKey, tenantId: site.tenantId } }, { meta });
        for (const w of resolved?.wants ?? []) wanted.add(w);
    }

    const existing = await ctx.broker.call('serve.want.find', { query: { siteId: input.siteId } }, { meta });
    const existingContracts = new Set(existing.map((w) => w.contract));

    const wantsAdded: string[] = [];
    for (const contract of wanted) {
        if (!existingContracts.has(contract)) {
            await ctx.broker.call('serve.want.create', { tenantId: site.tenantId, siteId: input.siteId, contract }, { meta });
            wantsAdded.push(contract);
        }
    }

    const wantsRemoved: string[] = [];
    for (const row of existing) {
        if (!wanted.has(row.contract)) {
            await ctx.broker.call('serve.want.delete', { id: row.id }, { meta });
            wantsRemoved.push(row.contract);
        }
    }

    const updatedSite = await ctx.broker.call('serve.cdn.update', { id: site.id, releaseHash: release.hash }, { meta });

    return { site: updatedSite, wantsAdded, wantsRemoved };
}
