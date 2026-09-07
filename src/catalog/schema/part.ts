/**
 * What can be installed: parts, and their versions.
 *
 * The catalog holds what *may* run. The cdn holds what *does*. Everything a site names resolves
 * through here, so this is the collection that makes `^1.4` mean anything at all.
 *
 * ## One collection, not three
 *
 * A kernel, an Application and an Extension are the same shape with a different `kind`. The
 * difference is cardinality in the *site* — one kernel, many parts — not shape in the catalog. Three
 * collections would be three copies of one resolver, and a marketplace listing would be three
 * queries and a merge.
 *
 * ## Versions are rows, not an array
 *
 * `part { …, versions: [...] }` is the obvious shape and it is wrong three ways: it grows without
 * bound, every publish rewrites the whole document, and it cannot answer the one query that matters —
 * *which version satisfies `^1.4`*. That query is the resolver's entire job.
 */

import { z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- the part

export const PartKindSchema = z.enum(['kernel', 'application', 'extension']);
export type PartKind = z.infer<typeof PartKindSchema>;

export const PartSchema = z.object({
    /**
     * What a site names when it says it loads this — `auth`, `process-monitor`.
     *
     * Not `id`: `defineCrud` mints that and refuses a schema declaring its own. So the domain key
     * lives beside a minted one, which means uniqueness is a **unique index plus a check**, never
     * the primary key. See `spec/building.md` §4a.
     *
     * **Flat, and that will not last.** Two publishers both wanting `auth` collide, and there is no
     * scoping here yet. npm answers this with `@scope/name`; whatever the answer is, it has to arrive
     * before anyone but us publishes, because renaming a part breaks every site that names it.
     */
    name: z.string().min(1),

    kind: PartKindSchema,

    /** Where the source is. A reference, resolvable by any builder — never a path. */
    repository: z.string().min(1),

    /**
     * Who may publish versions of it.
     *
     * → organization. A `partVersion` row is what a site resolves to, so whoever can write one can
     * change what runs on somebody else's hostname.
     */
    publisher: z.string().min(1),

    /**
     * ## Presentation — everything a person choosing a part needs, and nothing a build does
     *
     * **Identity is immutable; presentation is not**, and that distinction decides which row each
     * field lives on. `name` and `kind` are fixed at first publish and a version's `commit` can
     * never move — but a typo in a description, a new icon, a changed homepage must all be fixable
     * *without minting a version*, because a version means **this code**. Forcing a version bump to
     * fix a sentence would make version numbers meaningless as a record of what changed.
     *
     * So presentation lives here, on the part, and `catalog.publish` updates it on every publish.
     * The one exception is `changelog`, which belongs to a version and is immutable with it — see
     * `PartVersionSchema`.
     *
     * Worth having before a marketplace exists rather than after: a store showing a grid of bare
     * ids is exactly what makes people write descriptions into names.
     */
    description: z.string().default(''),

    /** Where to read more. A project page, a README, a docs site. */
    homepage: z.string().optional(),

    /** An SPDX identifier — `MIT`, `Apache-2.0`, `UNLICENSED`. A string, because it is a label. */
    license: z.string().optional(),

    /**
     * How somebody finds this without knowing its name.
     *
     * Free-form and lowercase by convention rather than by validation: a curated vocabulary is a
     * decision nobody can make correctly before there is anything to curate.
     */
    keywords: z.array(z.string()).default([]),

    /**
     * A path **within this part's artifact**, so an icon is content-addressed like everything else.
     *
     * Not a URL. A URL is a second thing to host, a second thing to expire, and a way for a
     * marketplace listing to reach off the platform — none of which an icon is worth.
     */
    icon: z.string().optional(),
});

// ---------------------------------------------------------------------------- a version

/**
 * What a version of a part *does*, as declared by its own code.
 *
 * A **requirement**, in the same sense as the contracts it calls: the part says what it needs, and a
 * site's policy says what it permits. A part must never state its own permission — if it could, then
 * installing one would be a privilege escalation with nobody in the loop.
 *
 * Three levels of enforcement exist behind this and they must not be blurred:
 *
 * - **declared** — this field. Compose-time refusal. Defeated by an author who just calls `fetch`.
 * - **checked** — the build scans the bundle for direct network use. Defeated by obfuscation.
 * - **enforced** — CSP on the generated page. Defeated by nothing, but it is per-*document*, so it
 *   is a property of a whole release: one part needing network makes the page network-capable.
 */
export const CapabilitiesSchema = z.object({
    /** Capability names from the part's own `needs(...)` — `mesh`, `credentials`, `state`, `log`. */
    needs: z.array(z.string()).default([]),
    /** Provider tokens it contributes, e.g. page chrome. What a site refuses when it says "no chrome". */
    provides: z.array(z.string()).default([]),
});

export const VersionStateSchema = z.enum([
    /** Published, not yet built. The row exists and is buildable — that is the point of it. */
    'declared',
    /** An artifact exists and at least one edge held it. */
    'built',
    /**
     * The artifact was built and no edge holds it any more.
     *
     * Not an error: an edge's disk is a cache, and a pod's storage is deleted on restart. This is the
     * signal to rebuild from `commit`, which is safe because the build is deterministic — several
     * edges discovering it at once all produce the same digest.
     */
    'gone',
]);
export type VersionState = z.infer<typeof VersionStateSchema>;

export const PartVersionSchema = z.object({
    /** → part.name. */
    partName: z.string().min(1),

    /**
     * An exact semver. Never a range — a range is what a *site* writes.
     *
     * **Immutable once published.** `(partName, version)` is unique, and a second publish either
     * matches the recorded commit — idempotent, fine — or is refused naming both commits. Without
     * that, `^1.4` resolves to bytes that can change underneath it, which is worse than having no
     * ranges at all.
     */
    version: z.string().min(1),

    /**
     * The commit this version is, and **the only identity that means anything**.
     *
     * A declared semver makes ranges resolvable; the commit makes them honest. It is also what a
     * rebuild needs: an edge's disk is a cache, so this plus a deterministic build is the entire
     * durability story.
     */
    commit: z.string().regex(/^[0-9a-f]{40}$/),

    /**
     * Where this version's commit lives, and **why it cannot live on the part**.
     *
     * A rebuild is `git fetch <repository> <commit>`, and until now it took the repository from the
     * *part* row and the commit from the *version* row. Those two can disagree the moment a part
     * moves repositories — which became possible on 2026-09-06 when `upsertPart` started updating
     * `part.repository`, and which is exactly what folding `mesh-auth` into a shared core repository
     * would do. Every previously published version would keep a commit that exists only in the old
     * repository, and its rebuild would ask the new one for a ref it has never heard of.
     *
     * So a version records its own. **A version is `(repository, commit, entry, subdirectory)` and
     * all four are immutable together** — `part.repository` means *where new versions come from*,
     * this means *where this one came from*. npm settles it the same way, for the same reason.
     *
     * Optional so the rows published before this existed still read; `build_start` falls back to
     * the part's, which is what those rows have always effectively used.
     */
    repository: z.string().min(1).optional(),

    /**
     * What changed in this version. **The one piece of presentation that is not on the part.**
     *
     * Everything else a person reads — description, icon, homepage — is fixable without minting a
     * version, because it describes the part rather than this code. A changelog entry is the
     * opposite: it describes *this* version, so it is immutable with it, and a changelog you can
     * edit afterwards is a changelog nobody can trust.
     */
    changelog: z.string().optional(),

    /** The source entry within the repository — `src/index.ts`. Part of the build's input hash. */
    entry: z.string().min(1),

    /** For a monorepo. A name within the repository, never a path on a disk. */
    subdirectory: z.string().min(1).optional(),

    /**
     * The kernel range this was written against, e.g. `^0.13`.
     *
     * "The only thing standing between a stale part and a browser." Enforced at release composition
     * time by `checkComposition`: if the release serves a kernel outside this declared range,
     * compose refuses with a fatal `kernel_mismatch` problem.
     *
     * Absent on a kernel artifact (which has no kernel of its own).
     * On a part, an absent range is accepted rather than refused so that parts published before this
     * field existed remain composable without breaking existing releases.
     */
    kernel: z.string().min(1).optional(),

    /** Contract keys this version calls, by name. Checked against the site's grants at compose time. */
    requires: z.array(z.string()).default([]),

    /**
     * Other parts this one needs on the page, as ranges.
     *
     * Resolved transitively: composing a site pulls in what its parts need, and what *those* need.
     * The failure this prevents is an application that consumes `AUTH` loading onto a page with no
     * auth Extension — which is a blank panel and a console error, not a message anybody can act on.
     */
    requiredParts: z.array(z.object({
        id: z.string().min(1),
        version: z.string().min(1),
        optional: z.boolean().default(false),
    })).default([]),

    capabilities: CapabilitiesSchema,

    state: VersionStateSchema,

    /** → artifact.digest. Absent while `declared`; absent again is not how `gone` is expressed. */
    artifactDigest: z.string().min(1).optional(),

    publishedAt: z.date(),
});
