/**
 * A site: a hostname, and everything it is made of.
 *
 * This is `mesh.json` after it stopped being a file. The file was always a sketch of a record — it
 * described several deployments at once because a repository has to, and a record does not.
 *
 * ## What changed on the way from file to row
 *
 * **`environments` is gone.** A site *is* a hostname, so `production` and `local` were never two
 * environments of one thing; they are two sites. `host` and `api` are fields, and `application` is a
 * grouping label rather than an identity.
 *
 * A consequence worth noticing: **a part is no longer built per environment.** It is built once,
 * versioned and hashed, and only the composition differs between one site and another. The old
 * descriptor had to bake `MESH_API` into a bundle, so the same source produced a different artifact
 * per environment. Here the API is a property of the site, and one artifact serves every site that
 * chooses it.
 *
 * **`mesh` names contracts by key, not by object.** `ExposeEntry` used to hold a `ToolContract`,
 * which is why an exposure list had to be TypeScript and why a repository had to ship a service half
 * to have one. `"domains.zone_create"` is a name, resolvable through the contract registry, and a
 * name is ordinary data.
 *
 * **Desired and resolved are separate.** `parts[].version` is what a person asked for — `^1.4`, or
 * `*`. `resolution` is what was actually composed, by digest. Different writers, so different fields:
 * the first is user CRUD, the second is written by the cdn and must not be settable through it.
 */

import { z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- what a site asks for

/**
 * A part someone wants in a composition — **not a stored field.**
 *
 * `version` is a *requirement* in npm's vocabulary: `1.4.2`, `^1.4`, `*`. It is what a person types
 * when composing a release and what `catalog.resolve` turns into an exact version, so it belongs to
 * the request rather than to any record. A site once stored these and it is why staging and
 * production could not be proved identical: two rows naming `^1.4` resolve independently, at
 * different times, against a catalog that moved in between.
 */
export const PartRefSchema = z.object({
    kind: z.enum(['application', 'extension']),
    /** → part.name in the catalog. */
    id: z.string().min(1),
    version: z.string().min(1),
});
export type PartRef = z.infer<typeof PartRefSchema>;

// ---------------------------------------------------------------------------- what goes on the internet

/**
 * One contract this site puts on the internet, and the gate in front of it.
 *
 * A union rather than two optional fields, and **`.strict()` on both branches**, so that an entry
 * with neither gate and an entry with *both* are equally unrepresentable. Optional fields would make
 * "I forgot to gate this" a valid record in a collection whose entire purpose is deciding what is
 * reachable from outside the mesh.
 *
 * `visibility: 'public'` on a contract means *may be exposed*, never *unauthenticated*. The gate is
 * here, per site, because who may call a thing is the deployment's decision and not the contract
 * author's.
 */
export const ExposedContractSchema = z.union([
    z.object({
        /** `domain.action`, e.g. `domains.zone_create`. */
        key: z.string().min(1),
        auth: z.enum(['public', 'user', 'admin']),
    }).strict(),
    z.object({
        key: z.string().min(1),
        permission: z.string().min(1),
    }).strict(),
]);
export type ExposedContract = z.infer<typeof ExposedContractSchema>;

/**
 * A package whose contracts this site exposes.
 *
 * Grouped by package because the grouping does two jobs at once: it is the dependency — which
 * package, at which version — and it is where a generator looks to resolve those keys to schemas.
 *
 * `contracts` is non-empty on purpose. A package named with nothing taken from it is a dependency
 * that does nothing, which is more likely a half-finished edit than an intention.
 */
export const MeshDependencySchema = z.object({
    package: z.string().min(1),
    version: z.string().min(1),
    contracts: z.array(ExposedContractSchema).min(1),

    /**
     * Events this site streams to a browser, and the gate on each.
     *
     * Separate from `contracts` although the keys look identical — `cdn.site_deployed` and
     * `identity.whoami` are the same shape — because they are looked up in different registries and
     * they fail differently. A contract key that resolves to nothing is a route that 404s; an event
     * key that resolves to nothing is a subscription that connects and stays silent forever, which
     * is far worse to diagnose.
     *
     * **Exposing an event is a heavier decision than exposing a contract.** A contract answers the
     * caller who asked; an event is pushed to everyone subscribed, so the question is not only *may
     * this caller see it* but *can this event even be narrowed to a caller* — and an event that
     * cannot be scoped is delivered to nobody. See `api/methods/delivery.ts`.
     */
    events: z.array(ExposedContractSchema).default([]),
});
export type MeshDependency = z.infer<typeof MeshDependencySchema>;

// What a site is *running* is not here any more. It was `resolution` — the kernel and parts the cdn
// had chosen — and it is now a `release`, in `./release.js`, for the reason that motivated the whole
// split: a resolution living on a site is a resolution done per site, so two hostnames meant to be
// identical were two independent resolutions against a catalog that moved between them.
//
// The exposure hash went with it, since it describes a set of parts rather than a hostname.

// ---------------------------------------------------------------------------- the site

export const SiteSchema = z.object({
    /**
     * The identity of a site, because a site is a hostname.
     *
     * Normalised: lowercased, port stripped, trailing dot removed. `localhost` and `127.0.0.1` are
     * different sites, which is what lets one node serve both.
     */
    host: z.string().min(1),

    /** A label for grouping several hosts that are the same product. Not an identity. */
    application: z.string().min(1),

    /**
     * The owner.
     *
     * → organization. The origin is the isolation boundary: serving two tenants from one hostname
     * puts one tenant's code in the other's origin, with its storage and its cookies. A serving-layer
     * invariant checks this, and it needs the answer to be on the record.
     */
    tenantId: z.string().min(1),

    /** Where the browser sends its calls. The one value a page cannot discover at run time. */
    api: z.string().min(1),

    /**
     * What this hostname serves — **→ release.hash. Changing it is the deploy.**
     *
     * The composition used to live here: a `kernel` range, `parts` ranges, and the resolution of
     * both. Three things were impossible while it did. Staging and production could not be *proved*
     * identical, because two rows naming `^1.4` resolve independently and at different times.
     * Rollback meant re-resolving rather than writing one field. And a hundred hostnames resolved a
     * hundred times over the same catalog.
     *
     * Absent means a site that exists and serves nothing yet — a hostname reserved before its first
     * deploy, which is an ordinary state and not an error.
     */
    releaseHash: z.string().min(1).optional(),

    /**
     * What this hostname exposes to the internet, and at what gate.
     *
     * **Stays on the site, and must.** A release says what its parts *call*; this says what is
     * reachable from outside and to whom, which is a deployment's decision — one site may expose
     * `domains.zone_find` as `public` while another requires `user`, on the same release. Composing
     * checks one list against the other.
     */
    mesh: z.array(MeshDependencySchema),

    /**
     * Theme tokens: name → value.
     *
     * The kernel ships the rules and a site supplies the values, which is what lets two instances of
     * one application sit side by side under different themes with a single stylesheet between them.
     *
     * Typed as strings rather than left open, per the schema rules: an escape hatch is typed to the
     * subset actually supported. A token is a CSS value, and a CSS value is a string.
     */
    theme: z.record(z.string(), z.string()),

    /**
     * Enforced by the cdn rather than baked into a build, so that changing one does not mean
     * rebuilding a part that did not change. Strings for the same reason as `theme`.
     */
    policy: z.record(z.string(), z.string()),

    /**
     * What a person reads, and what a crawler reads.
     *
     * On the site rather than the release, because it is per hostname: two sites on one release are
     * the same application under different identities. It reaches the **document** — the cdn
     * generates `index.html` per request, so a title here is a real `<title>` rather than something
     * a script sets after the page has already been indexed.
     */
    title: z.string().default(''),
    description: z.string().default(''),
    /** The canonical URL, when this hostname is one of several serving the same thing. */
    canonical: z.string().optional(),
    /** A path within an artifact this release serves, so it is content-addressed like everything else. */
    image: z.string().optional(),
    /** Whether crawlers should index it. A staging site on the same release as production must not. */
    indexable: z.boolean().default(true),
});

// No `export type Site` here. The site *object* is what the collection returns — `id`, `createdAt`
// and `updatedAt` included — and it is inferred from `siteCrud.outputSchema` in
// `../contracts/site.contract.js`. This file describes what is written; that one describes what
// exists. Exporting a `Site` from both would be two types that agree until the day they do not.
