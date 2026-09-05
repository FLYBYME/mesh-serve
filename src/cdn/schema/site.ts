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

// ---------------------------------------------------------------------------- parts

/**
 * A part this site loads into the page.
 *
 * `version` is a *requirement*, in npm's vocabulary — `1.4.2`, `^1.4`, `*`. Not to be confused with a
 * record version for concurrency, which this schema deliberately does not have: ordering is by the
 * framework's `updatedAt`.
 */
export const PartRefSchema = z.object({
    kind: z.enum(['application', 'extension']),
    /** → part.id in the catalog. */
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
});
export type MeshDependency = z.infer<typeof MeshDependencySchema>;

// ---------------------------------------------------------------------------- what was actually composed

export const ResolvedArtifactSchema = z.object({
    /** The exact version chosen, never the range it was chosen for. */
    version: z.string().min(1),
    /** → artifact.digest. What is actually served. */
    digest: z.string().min(1),
});

/**
 * What the cdn composed, and the answer to *what is this site actually running*.
 *
 * **Written by the cdn.** Not settable through user CRUD: a resolution someone typed would be a
 * claim about what is running rather than a record of it, and the whole point of separating this
 * from `parts` is that one is an intention and the other is an observation.
 */
export const ResolutionSchema = z.object({
    kernel: ResolvedArtifactSchema,
    parts: z.record(z.string(), ResolvedArtifactSchema),
    /**
     * The hash of the exposure this site's parts were generated against.
     *
     * A client generated from one exposure and pointed at an API serving another is a lie the
     * compiler vouches for, which is worse than no types at all. Recorded here so a mismatch is an
     * error at compose time rather than a confusing 404 three calls later.
     */
    exposure: z.string().min(1),
    /** → artifact.digest of the page and boot module the cdn generated for this composition. */
    page: z.string().min(1),
    resolvedAt: z.date(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

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

    /** A version requirement, resolved against the catalog. */
    kernel: z.string().min(1),

    parts: z.array(PartRefSchema),
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

    /** Written by the cdn. Absent until this site has been composed. */
    resolution: ResolutionSchema.optional(),
});
export type Site = z.infer<typeof SiteSchema>;
