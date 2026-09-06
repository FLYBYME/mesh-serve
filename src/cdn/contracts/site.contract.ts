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
 * narrow a result set. So the rule was: **`site.find` is never exposed.** Enumerating every hostname
 * on the platform is exactly the shape of that mistake.
 *
 * **Reads are exposed as of 2026-09-06, and the rule above is why it is safe.** `scopedBy` (D3)
 * removed the clause the rule rested on: a `find` here is now a find within the caller's own
 * organization, so there is no unbounded result set left to hand out. paas's mistake was not
 * exposing a `find` — it was exposing one that *could not be narrowed*.
 *
 * Writes stay internal. `create` is a site being provisioned and `update` reaching `releaseHash`
 * would be a deploy with none of `cdn.deploy`'s checks.
 */

import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

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
    /**
     * **Every generated read and write is inside the caller's organization.**
     *
     * This is the mechanism that replaces a discipline. Until mesh 2.2.0 the rule was *never expose
     * an unbounded find*, kept by whoever remembered — and an unbounded `site.find` enumerates every
     * hostname on the platform, which is exactly the shape of the mistake that ran through 100,000
     * lines of the previous generation. Authorization could refuse a *caller* and never narrow a
     * *result set*, so no contract could have said otherwise.
     *
     * Now `find` is always within the caller's scope, `create` stamps it, `update` cannot reparent a
     * row, and a `get` across the boundary answers **404** — because *"it exists, but not for you"*
     * is itself a disclosure.
     *
     * It refuses a call carrying no caller, which is why `cdn.resolve_site` exists: the serving path
     * asks *what does this hostname serve* on behalf of a browser, and a browser is anonymous.
     * Serving and managing are two operations and they get two doors.
     */
    scopedBy: 'tenantId',

    /**
     * **Reads only, and only because of the `scopedBy` directly above.**
     *
     * The comment above this collection says the serving path and the managing path *"get two
     * doors"*, and this is the managing one. `cdn.resolve_site` answers a browser anonymously and
     * reads the collection directly; this answers an operator, through the scope, and returns only
     * their own hostnames.
     *
     * `update` stays internal even though a deploy is one field write, because **which release a
     * hostname serves is `cdn.deploy`'s decision**: it checks that the release belongs to the same
     * tenant, and that every contract the release calls is one the site exposes. A generated
     * `site.update` reaching `releaseHash` would be a deploy with neither check. Roadmap F2.
     */
    visibility: { find: 'public', findOne: 'public', get: 'public', count: 'public' },

    /**
     * **`global`, and this is the case that shows the choice cannot be defaulted.**
     *
     * Every other field on a scoped collection would sensibly be unique *within* an organization —
     * two tenants both wanting a slug of `main` is normal, and a global rule would break them for
     * each other. A hostname is the opposite: it is **one origin on the internet**, so a second row
     * claiming it is a tenant takeover, and a scoped rule would permit exactly that.
     *
     * Both defaults are wrong, silently, in opposite directions. mesh 2.4.0 therefore refuses a bare
     * unique key on a scoped collection and makes the boundary explicit here, which is the only
     * place that knows which kind of name this is.
     */
    unique: [{ fields: 'host', scope: 'global' }],

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
 * One site, by hostname, for serving.
 *
 * **This exists so that `site` can be scope-restricted without taking every page down.**
 *
 * mesh 2.2.0 lets a collection declare `scopedBy`, so a generated `find` is always within the
 * caller's resolved scope — which is the mechanism that turns *never expose an unbounded find* from
 * a discipline into something a contract enforces. Adopting it on `site` refuses any call carrying
 * no caller, and the two calls that matter most carry none: the cdn and the api both resolve
 * `Host → site` for a **browser**, which is anonymous by definition.
 *
 * The tempting fix is to let the serving path bypass CRUD and read the collection directly. That
 * works and costs too much — the serving path would stop going through contracts, which is the thing
 * that lets any node serve any site.
 *
 * So this is the repository's own rule applied instead: anything with an invariant is an explicit
 * contract. **Resolving a hostname for serving is a different operation from listing my sites**, and
 * its invariant is exactly that it returns *one* site by hostname and can never enumerate. Two
 * callers, two doors:
 *
 * | | who | what it can do |
 * | --- | --- | --- |
 * | `cdn.resolve_site` | anyone, including a browser | one site, by exact hostname |
 * | `site.find` | a signed-in caller, scoped | their own sites, never exposed |
 *
 * `public` because it must be callable with no ticket, and it discloses only what the hostname
 * already serves to anyone who visits it.
 */
export const resolveSiteContract = defineContract({
    domain: 'cdn',
    action: 'resolve_site',
    description: 'One site, by hostname, for serving.',
    inputSchema: z.object({ host: z.string().min(1) }),
    // The collection's own output shape, so a field added to `SiteSchema` appears here and the two
    // cannot drift.
    outputSchema: siteCrud.get.outputSchema,
    rest: { method: 'GET', path: '/sites/:host' },
    visibility: 'public',
    print: (o) => `${o.host} → ${o.releaseHash ?? 'not deployed'}`,
});

/**
 * A site now serves a different release.
 *
 * Every serving node listens and drops that hostname from its cached pages. **Latency, not
 * correctness**: a node that misses the event serves the previous release until its cache entry
 * expires, which is a stale page rather than a wrong one — and the mesh delivers at-most-once, so
 * the TTL is doing real work rather than tidying up after the event.
 */
export const SiteDeployedSchema = z.object({
    /**
     * Whose site, and **the reason this event can be delivered at all**.
     *
     * Added 2026-09-06. The payload was `host`, `release`, `previousRelease` — everything a listener
     * needs *except* who it concerns, because the only listeners were other services and they had
     * the site record already. An event that cannot be scoped is delivered to nobody, so a live
     * deploy view was impossible rather than merely unbuilt.
     */
    tenantId: z.string().min(1),
    host: z.string(),
    /** → release.hash. */
    release: z.string(),
    /** What it served before, so a listener can say what changed and a rollback is legible. */
    previousRelease: z.string().optional(),
});
export type SiteDeployed = z.infer<typeof SiteDeployedSchema>;

/**
 * `scopedBy: 'tenantId'` — a hostname going live is the most operationally interesting thing that
 * happens here, and it is exactly as private as the site record it comes from.
 */
export const siteDeployedEvent = defineEvent('cdn.site_deployed', SiteDeployedSchema, {
    scopedBy: 'tenantId',
});
