/**
 * `cdn.all_sites` — every site on the cluster, for an operator.
 *
 * The third door into the `site` collection. See `allSitesContract` for the argument: `site` is
 * `scopedBy: 'tenantId'`, a cluster operator belongs to no tenant, and administering a deployment is
 * not the same operation as managing your own sites.
 *
 * This is the **second** confined bypass of scoped CRUD in this service, and the first one's doc
 * (`tools/resolve_site.ts`) is the standard it has to meet: the bypass is defensible only while the
 * invariant is stated where the read happens and is checkable by reading one function.
 *
 * Here the invariant is not *cannot enumerate* — this contract exists to enumerate. It is:
 *
 * 1. **The caller holds the cluster-scoped `operator` role**, checked here rather than trusted from
 *    the site record that exposed the contract. A gate is configuration; this is not.
 * 2. **The query is built here, from three named fields.** Nothing a caller sends reaches the
 *    repository as structure — `search` becomes an escaped hostname regex and `tenantId` an equality
 *    on one field. There is no path from input to an arbitrary mongo query.
 * 3. **The result is bounded**, and says when it was cut short.
 */

import { MeshError, z, type IServiceContext } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import { allSitesContract } from '../contracts/site.contract.js';
import { normalizeHostname } from '../methods/hostname.js';

type Input = z.infer<typeof allSitesContract['inputSchema']>;
type Output = z.infer<typeof allSitesContract['outputSchema']>;

/** Cluster-scoped, and the only role that may see the whole deployment. Mirrors identity's F3. */
const OPERATOR_ROLE = 'operator';

export async function cdn_all_sites(
    this: CdnService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = (ctx.meta as { user?: { roles?: string[] } } | undefined)?.user;
    if (!(caller?.roles ?? []).includes(OPERATOR_ROLE)) {
        throw new MeshError({
            code: 'FORBIDDEN',
            status: 403,
            message:
                'cdn.all_sites requires the cluster-scoped operator role. To list your own '
                + 'organization\'s sites, use site.find.',
        });
    }

    const query: Record<string, unknown> = {};
    if (input.tenantId !== undefined) query['tenantId'] = input.tenantId;
    if (input.search !== undefined) {
        // Normalised the way a stored hostname is, so searching `Example.COM` finds `example.com`,
        // and escaped because a search box is caller input and `.*` is a collection scan.
        const needle = normalizeHostname(input.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query['host'] = { $regex: needle, $options: 'i' };
    }

    // One more than asked for: whether there are more is answered by this query rather than by
    // counting a collection nobody asked to have counted.
    const found = await this.siteRepo().find({ query, limit: input.limit + 1 });
    const truncated = found.length > input.limit;

    return { sites: found.slice(0, input.limit) as Output['sites'], truncated };
}
