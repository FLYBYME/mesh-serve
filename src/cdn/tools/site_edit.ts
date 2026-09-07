/**
 * `cdn.site_edit` — change what a site is, never what it serves.
 *
 * The whole design is the field that is **absent** from the input: `releaseHash`. Writing that is a
 * deploy, and `cdn.deploy` earns the right to write it by checking that the release belongs to this
 * tenant and that every contract it calls is one the site exposes. A contract without the field
 * cannot be argued into skipping those checks.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import { siteEditContract } from '../contracts/site.contract.js';
import { normalizeHostname } from '../methods/hostname.js';

type Input = z.infer<typeof siteEditContract['inputSchema']>;
type Output = z.infer<typeof siteEditContract['outputSchema']>;

export async function cdn_site_edit(
    this: CdnService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const host = normalizeHostname(input.host);

    /**
     * Found through the scoped collection, deliberately — not `cdn.resolve_site`.
     *
     * `resolve_site` answers a browser anonymously and reads the collection directly, which is right
     * for serving a page and wrong here: editing is a managing operation, and it must see only the
     * caller's own hostnames. Using the serving door would let anybody edit anybody's site.
     */
    const site = await ctx.call('site.find_one', { query: { host } });
    if (site === null || site === undefined) {
        // 404 rather than 403, the same as every other cross-scope read here: "it exists, but not
        // for you" is itself a disclosure.
        throw new ClientError(`No site is configured for ${host}.`, 'site_not_found', 404);
    }

    /**
     * Only what was sent, and **absent means unchanged rather than cleared**.
     *
     * A schema-driven form sends the fields a person touched. Spreading the input wholesale would
     * write `undefined` over every field they did not, so the first edit of a title would blank the
     * theme — which looks like data loss and is data loss.
     */
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) changes['title'] = input.title;
    if (input.description !== undefined) changes['description'] = input.description;
    if (input.indexable !== undefined) changes['indexable'] = input.indexable;
    if (input.theme !== undefined) changes['theme'] = input.theme;
    if (input.policy !== undefined) changes['policy'] = input.policy;

    if (Object.keys(changes).length === 0) return site as Output;

    const updated = await ctx.call('site.update', { id: site.id, ...changes });
    return updated as Output;
}
