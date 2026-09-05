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

    description: z.string().default(''),
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

    /** The source entry within the repository — `src/index.ts`. Part of the build's input hash. */
    entry: z.string().min(1),

    /** For a monorepo. A name within the repository, never a path on a disk. */
    subdirectory: z.string().min(1).optional(),

    /** The kernel range this was written against. Absent on a kernel, which has no kernel. */
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
