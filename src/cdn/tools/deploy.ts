import { Database, MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { releaseCrud } from '../../catalog/contracts/release.contract.js';
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
    const site = await ctx.call('serve.cdn.resolveById', { id: input.siteId });
    const meta = { tenant_id: site.tenantId };

    // Raw db lookup, not serve.release.resolve -- that's scoped by the caller's own tenant meta,
    // which here is the *site's* tenant, and would silently report "not found" for a cross-tenant
    // release instead of letting the explicit tenant check below produce the real 400. Same
    // reasoning as getRelease.ts's own anonymous, unscoped lookup.
    const db = ctx.broker.getProvider<Database>('database');
    const release = await db.repo(releaseCrud.outputSchema, 'serve.release').get(input.releaseId);
    if (release === undefined) {
        throw new MeshError({ message: `No release "${input.releaseId}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (release.tenantId !== site.tenantId) {
        throw new MeshError({
            message: `Release "${input.releaseId}" belongs to a different organization than site "${input.siteId}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }
    if (release.hash === undefined) {
        throw new MeshError({ message: `Release "${input.releaseId}" has no hash.`, code: 'INTERNAL', status: 500 });
    }

    const composition = await ctx.db('serve.composition', meta).resolve({ id: release.compositionId });
    if (composition === undefined) {
        throw new MeshError({ message: `Release "${input.releaseId}" has no composition.`, code: 'NOT_FOUND', status: 404 });
    }
    if (composition.key !== site.application) {
        throw new MeshError({
            message: `Release "${input.releaseId}" composes "${composition.key}", but site "${input.siteId}" serves "${site.application}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const wanted = new Set<string>();
    for (const artifact of release.artifacts) {
        const resolved = await ctx.db('serve.part', meta).resolve({ id: artifact.partId });
        for (const w of resolved?.wants ?? []) wanted.add(w);
    }

    const existing = await ctx.db('serve.want', meta).find({ query: { siteId: input.siteId } });
    const existingContracts = new Set(existing.map((w) => w.contract));

    const wantsAdded: string[] = [];
    for (const contract of wanted) {
        if (!existingContracts.has(contract)) {
            await ctx.db('serve.want', meta).create({ tenantId: site.tenantId, siteId: input.siteId, contract });
            wantsAdded.push(contract);
        }
    }

    const wantsRemoved: string[] = [];
    for (const row of existing) {
        if (!wanted.has(row.contract)) {
            await ctx.db('serve.want', meta).delete({ id: row.id });
            wantsRemoved.push(row.contract);
        }
    }

    const updatedSite = await ctx.db('serve.cdn', meta).update({ id: site.id, releaseHash: release.hash });

    return { site: updatedSite, wantsAdded, wantsRemoved };
}
