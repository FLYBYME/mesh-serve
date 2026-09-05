/**
 * `cdn.resolve_site` — one site, by hostname, for serving.
 *
 * The serving path's door into the `site` collection, and the reason it has its own: a browser is
 * anonymous, so the call that answers *what does this hostname serve* carries no caller, and a
 * scope-restricted `find` would refuse it. See the contract for the argument.
 *
 * It is deliberately the narrowest thing that works. One hostname in, one site out, no query, no
 * limit, nothing to enumerate with.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import { resolveSiteContract } from '../contracts/site.contract.js';
import { normalizeHostname } from '../methods/hostname.js';

type Input = z.infer<typeof resolveSiteContract['inputSchema']>;
type Output = z.infer<typeof resolveSiteContract['outputSchema']>;

export async function cdn_resolve_site(
    this: CdnService,
    input: Input,
    _ctx: IServiceContext,
): Promise<Output> {
    // Normalised here rather than trusted: `Example.com`, `example.com:443` and `example.com.` are
    // one site, and a lookup keyed on the raw value would find a site under one spelling and miss it
    // under another.
    const host = normalizeHostname(input.host);

    /**
     * **The one place in this repository that reads a collection without going through CRUD.**
     *
     * Not a shortcut, and the first version of this tool did not do it — it called `site.find_one`,
     * which is scope-restricted, and every page request 404'd because the caller is a browser and a
     * browser has no organization. A door that opens into the same locked room is not a second door.
     *
     * So the bypass is real and it is confined to these four lines, where the invariant is stated and
     * checkable: **one site, by exact hostname, and nothing here can enumerate.** There is no query
     * parameter, no limit, no filter a caller can influence — the only input is a hostname, and the
     * answer is the site that hostname already serves to anyone who visits it.
     *
     * That is the whole argument for confining it rather than letting the serving path read the
     * collection freely. One function with a stated invariant can be reviewed; a serving path with
     * database access cannot.
     */
    const [found] = await this.siteRepo().find({ query: { host }, limit: 1 });

    if (found === undefined) {
        throw new ClientError(
            `No site is configured for ${host}.`, 'site_not_found', 404,
        );
    }

    return found as Output;
}
