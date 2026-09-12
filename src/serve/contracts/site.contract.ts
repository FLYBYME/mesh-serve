/**
 * Sites: what a hostname resolves to.
 *
 * `spec/serving.md`. One collection and one lookup. The lookup is separate from `site.find` because
 * it runs on the serving path for every request, is keyed by a normalised hostname rather than by a
 * query, and must answer for an anonymous caller — a browser fetching a page is not signed in.
 */

import { defineContract, defineCrud, type ToolContract, z } from '@flybyme/mesh';

import { SiteSchema } from '../schema/site.js';

/**
 * Sites. **A public collection with an owner field, not a scoped one.**
 *
 * `spec/collections.md` §3.3 draws the distinction and §2 states the rule this follows: *a collection
 * that cannot be read without a scope cannot be on the serving path, because a browser fetching a
 * page is anonymous by definition.* Resolving a hostname is the first thing every request does, and
 * it happens before there is a caller, let alone a scope.
 *
 * So `organizationId` is here as the **owner**, and what gates a write against it is **B1** — the
 * question the spec says blocks every public collection. It is not built. Until it is, `create` is
 * reachable only where a site exposes it, and the control site exposes it at `user`.
 *
 * **`host` is unique globally**, which is a different claim from unique per organization and the
 * more important one: a hostname resolves to one site or the platform guesses, and a platform that
 * guesses is one tenant receiving another's traffic.
 */
export const siteCrud = defineCrud('site', SiteSchema, {
    pluralPath: 'sites',
    unique: [{ fields: 'host', scope: 'global' }],
    /**
     * Reads and `create`. **`update` stays internal and that is not an oversight.**
     *
     * A site's `contracts` list is its security model, so an update is *change what this hostname
     * will answer* — the one write on this collection that must not be a general-purpose patch. It
     * comes back as a contract that takes an exposure and says what it is changing, once there is a
     * release to check the exposure against.
     */
    visibility: { find: 'public', get: 'public', count: 'public', create: 'public' },
    dependencies: [],
});

export type StoredSite = z.infer<typeof siteCrud.outputSchema>;

/**
 * One site, by hostname, for serving.
 *
 * **Internal.** This is how a projection asks *which site is this connection for*, and it answers
 * with the site's whole exposure — the gate of every contract it serves. That is a map of the
 * security model, and a map of the security model is not a public read.
 */
export const resolveSiteContract = defineContract({
    domain: 'site',
    action: 'resolve_host',
    description: 'One site, by hostname, for serving.',
    inputSchema: z.object({
        host: z.string().min(1).describe('Normalised by the caller. Normalised again here'),
    }),
    outputSchema: siteCrud.outputSchema.optional(),
    rest: { method: 'GET', path: '/sites/by-host/:host' },
    print: (o) => (o === undefined ? 'no site' : `${o.host} -> ${o.organizationId}`),
});

/**
 * **There is no `site.describe` contract, and that is deliberate.**
 *
 * A description is *what the hostname you are talking to serves*. As a contract it would need a host
 * parameter, and a host parameter is a caller reading another site's exposure — the map of its
 * security model — from a site they happen to be able to reach.
 *
 * So the projection answers `/_describe` from the site it has already resolved, using
 * `describeSite` in `../methods/descriptor.js`. A pure function over a site and the contracts a node
 * has mounted, with no way to ask about a site the connection did not arrive on.
 */
export const allSiteContracts: readonly ToolContract<z.ZodTypeAny, z.ZodTypeAny>[] = [
    resolveSiteContract,
];
