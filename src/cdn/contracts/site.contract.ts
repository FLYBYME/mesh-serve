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
    // A site is a hostname, so the hostname is the key. An invented id would mean every lookup on
    // the serving path — the hot one, on every request — needed a secondary index to answer the only
    // question ever asked of this collection.
    idField: 'host',
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
 * A site now serves something else.
 *
 * Every serving node listens and drops that hostname from its cache. **Latency, not correctness**:
 * a node that misses the event serves the previous composition until its cache entry expires, which
 * is a stale page rather than a wrong one.
 */
export const SiteComposedSchema = z.object({
    host: z.string(),
    /** → artifact.digest of the generated page. */
    page: z.string(),
    previousPage: z.string().optional(),
});
export type SiteComposed = z.infer<typeof SiteComposedSchema>;

export const siteComposedEvent = defineEvent('cdn.site_composed', SiteComposedSchema);
