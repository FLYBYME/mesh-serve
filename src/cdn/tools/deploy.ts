/**
 * `cdn.deploy` — point a hostname at a release.
 *
 * **One field.** That is the whole deploy, and it is why rollback is the same write backwards: no
 * rebuild, no re-resolution, nothing to get wrong at the moment somebody is under pressure.
 *
 * ## This is where grants are checked, and it can only be here
 *
 * A release says what its parts **call**. A site says what it **exposes and at what gate**. Neither
 * can check the other alone — a release is deliberately site-independent, which is what lets a
 * hundred hostnames share one — so the check happens at the one moment both halves are in hand.
 *
 * A part calling a contract the site does not expose is refused, naming both. Otherwise it is a 404
 * at run time, indistinguishable from a route that never existed, found by whoever opens the page.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import { deployContract } from '../contracts/release.contract.js';
import { normalizeHostname } from '../methods/hostname.js';

type Input = z.infer<typeof deployContract['inputSchema']>;
type Output = z.infer<typeof deployContract['outputSchema']>;

export async function cdn_deploy(
    this: CdnService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const host = normalizeHostname(input.host);

    const site = await ctx.call('site.find_one', { query: { host } });
    if (site === null || site === undefined) {
        throw new ClientError(`No site is configured for ${host}.`, 'site_not_found', 404);
    }

    const release = await ctx.call('release.find_one', { query: { hash: input.release } });
    if (release === null || release === undefined) {
        throw new ClientError(`No release ${input.release}.`, 'release_not_found', 404);
    }

    // The origin is the isolation boundary, so a site may not serve another tenant's composition:
    // that would put one tenant's code in the other's origin, with its storage and its cookies.
    if (release.tenantId !== site.tenantId) {
        throw new ClientError(`No release ${input.release}.`, 'release_not_found', 404);
    }

    const granted = new Set(site.mesh.flatMap((dependency) =>
        dependency.contracts.map((contract) => contract.key)));

    const ungranted = release.requires.filter((key) => !granted.has(key));
    if (ungranted.length > 0) {
        throw new ClientError(
            `${host} does not expose ${ungranted.join(', ')}, and this release calls ` +
            `${ungranted.length === 1 ? 'it' : 'them'}. A part must never choose its own gate, so ` +
            `add ${ungranted.length === 1 ? 'it' : 'them'} to the site's mesh list with a gate, or ` +
            `deploy a release that does not call ${ungranted.length === 1 ? 'it' : 'them'}.`,
            'contract_not_exposed', 409,
        );
    }

    // Reported, never refused: a grant nothing calls is the route somebody left behind when they
    // deleted the screen that used it. Worth seeing, not worth failing a deploy over.
    const required = new Set(release.requires);
    const unused = [...granted].filter((key) => !required.has(key)).sort();

    const previous = site.releaseHash;
    if (previous === input.release) {
        // Nothing changed. Said rather than silently repeated, because a deploy that appears to have
        // done something when it did not is how a stale build gets believed.
        return { host, release: input.release, changed: false, unusedGrants: unused };
    }

    await ctx.call('site.update', { id: site.id, releaseHash: input.release });

    ctx.emit('cdn.site_deployed', {
        host,
        release: input.release,
        ...(previous === undefined ? {} : { previousRelease: previous }),
    });

    ctx.logger.info(
        `[cdn] ${host} → ${input.release}${previous === undefined ? '' : ` (was ${previous})`}`,
    );

    return { host, release: input.release, changed: true, unusedGrants: unused };
}
