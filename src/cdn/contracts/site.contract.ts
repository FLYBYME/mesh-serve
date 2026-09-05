/**
 * What the cdn owns: which sites exist, and what each is made of.
 *
 * ## Why this is `defineCrud` and not eight hand-written contracts
 *
 * A site is a *record*. Reading one, listing them, creating and updating them are the ten actions
 * `defineCrud` generates from the schema, and writing them by hand produces a closed collection —
 * reachable only through whichever accessors somebody thought to write, so every new question needs a
 * new contract and a new store method. mesh-identity is what that looks like at 160 lines of
 * hand-rolled store for records the framework would have served for free.
 *
 * ## Generated in full, exposed almost not at all
 *
 * `defineCrud` mounts the whole bundle on the broker, and that is right: any service on the mesh may
 * ask what a site is made of. **What goes on the internet is a separate and much smaller decision**,
 * made per site by its own `mesh` list.
 *
 * This is the discipline paas did not have, and it is the specific way its 100k lines went wrong:
 * `user.find`, `organization.get` and friends were reachable as though public, and an unbounded
 * `find` has no notion of the caller's scope — authorization can refuse a caller, but it cannot
 * narrow a result set. So: **`site.find` is never exposed.** Enumerating every hostname on the
 * platform is exactly the shape of that mistake.
 */

import { defineCrud, defineEvent, z } from '@flybyme/mesh';

import { SiteSchema } from '../schema/site.js';

export const siteCrud = defineCrud('site', SiteSchema, {
    /**
     * The default `id`, and **not `idField: 'host'`** — which is what this said until the framework
     * refused it.
     *
     * The reasoning was: a site is a hostname, so the hostname should be the key, or every lookup on
     * the serving path needs a secondary index. The reasoning was right and the mechanism was wrong.
     * `defineCrud` builds its create input as `baseSchema.omit({ id, _id, createdAt, updatedAt })`,
     * so **nothing can supply an id** — the database mints one. `idField` only renames that minted id
     * on the wire, so `idField: 'host'` would have produced `site.get({ host: '68a1f2c…' })`: a
     * hostname-shaped parameter holding a mongo id.
     *
     * So `host` stays an ordinary field, the serving path asks `site.find_one({ query: { host } })`,
     * and the secondary index is a real index rather than a naming trick. Uniqueness on `host` has
     * to be enforced somewhere it can actually be enforced — see below.
     */
    pluralPath: 'sites',

    /**
     * Empty, and that is an answer rather than a default.
     *
     * These handlers call nothing: reading and writing a site record touches no other domain. The
     * things that *do* have dependencies — resolving `parts` against the catalog, checking that
     * `tenantId` names a real organization — are explicit contracts, because CRUD here is used
     * idiomatically and never hooked. A generated handler that quietly reached into identity would
     * be a dependency nothing declared and no scheduler could see.
     */
    dependencies: [],
});
/**
 * A site.
 *
 * **From the collection, not from the schema.** `SiteSchema` describes what someone writes;
 * `defineCrud` adds `id`, `createdAt` and `updatedAt`, and what every reader actually handles is the
 * document that comes back. Inferring it here means a field added to the schema appears for free and
 * a field the framework adds cannot be forgotten — and it means there is one `Site` type rather than
 * two that agree until they do not.
 */
export type Site = z.infer<typeof siteCrud.outputSchema>;

/**
 * A site now serves a different release.
 *
 * Every serving node listens and drops that hostname from its cached pages. **Latency, not
 * correctness**: a node that misses the event serves the previous release until its cache entry
 * expires, which is a stale page rather than a wrong one — and the mesh delivers at-most-once, so
 * the TTL is doing real work rather than tidying up after the event.
 */
export const SiteDeployedSchema = z.object({
    host: z.string(),
    /** → release.hash. */
    release: z.string(),
    /** What it served before, so a listener can say what changed and a rollback is legible. */
    previousRelease: z.string().optional(),
});
export type SiteDeployed = z.infer<typeof SiteDeployedSchema>;

export const siteDeployedEvent = defineEvent('cdn.site_deployed', SiteDeployedSchema);
