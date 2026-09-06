/**
 * What the catalog owns: which parts exist, and which versions of them.
 *
 * Two collections and two explicit contracts, split by the rule this repository follows everywhere —
 * **CRUD is generated in full and used idiomatically; anything with a side effect or an invariant is
 * an explicit contract that does the work and then writes through the normal CRUD path.**
 *
 * Reading a part is a read. Publishing a version is not: it has an invariant that cannot be expressed
 * in a schema — *a version already published may not change what it points at* — so `publish` exists
 * and `partVersion.create` is called by nothing else.
 *
 * ## What is exposed
 *
 * Unusually for this repository, **`part.find` is fine to expose.** A catalog is a marketplace; its
 * whole purpose is to be browsed, and every row in it is public by construction. That is not an
 * exception to *never expose an unbounded find* so much as a case where the result set has no
 * caller-scoped subset to narrow to.
 *
 * `partVersion.find` is different only in that a query naming no part returns every version of
 * everything, which is a bad answer rather than a disclosure. It takes a `partName`.
 */

import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { CapabilitiesSchema, PartKindSchema, PartSchema, PartVersionSchema } from '../schema/part.js';

// ---------------------------------------------------------------------------- collections

export const partCrud = defineCrud('part', PartSchema, {
    pluralPath: 'parts',

    // A part name is what a site writes to install one, so it is one namespace for everybody.
    // Flat and global, which is a decision with a cost recorded on `PartSchema.name`: two publishers
    // both wanting `auth` collide, and there is no scoping yet.
    unique: [{ fields: 'name', scope: 'global' }],
    // Reading and writing a part record touches no other domain. Publishing a version does — it
    // checks the publisher and refuses a changed commit — and that is `publish`'s job, not a hooked
    // create.
    dependencies: [],
});

export const partVersionCrud = defineCrud('partVersion', PartVersionSchema, {
    pluralPath: 'part-versions',

    /**
     * **This is what makes *a published version is immutable* true rather than likely.**
     *
     * `catalog.publish` checks for an existing version and refuses a different commit, and that
     * check is correct and cannot be made safe on its own: two publishes of the same version can
     * interleave between the read and the write, and both succeed. Every version range in the system
     * rests on that not happening — `^1.4` resolving to bytes that changed underneath it is the
     * failure the whole catalog exists to prevent.
     *
     * An application-level check cannot close a race with itself. Only the database refusing the
     * second write can, which is why this is *making an existing guarantee true* rather than adding
     * a constraint.
     *
     * Global, because a version is global: `auth@0.1.0` means one commit for everybody, and that is
     * the point of publishing it.
     */
    unique: [{ fields: ['partName', 'version'], scope: 'global' }],

    dependencies: [],
});

/** A part, as stored — `id`, `createdAt` and `updatedAt` included. */
export type Part = z.infer<typeof partCrud.outputSchema>;
export type PartVersion = z.infer<typeof partVersionCrud.outputSchema>;

// ---------------------------------------------------------------------------- publishing

/**
 * Publish one version of a part.
 *
 * Creates the `part` row on first publish — `mesh.json` is the genesis object, and this is where it
 * stops being a file — and one `partVersion` row every time.
 *
 * ## The invariant
 *
 * **A published version never changes what it points at.** Re-publishing `1.0.0`:
 *
 * - from the same commit → **idempotent**, returns the existing row. A CI job that runs twice is not
 *   an error.
 * - from a different commit → **refused, naming both commits.** Otherwise `^1.0` resolves to bytes
 *   that changed underneath it, and every site pinning that range silently gets different code.
 *
 * And the part's own identity is fixed at first publish. A repository whose `mesh.json` later
 * changes `kind` is describing a different part, and is refused by name rather than quietly
 * overwriting the first — which is the same rule, applied to the genesis object instead of a version.
 */
export const publishContract = defineContract({
    domain: 'catalog',
    action: 'publish',
    description: 'Publish one version of a part, creating the part on first publish.',
    inputSchema: z.object({
        name: z.string().min(1),
        kind: PartKindSchema,
        repository: z.string().min(1),
        publisher: z.string().min(1),
        description: z.string().optional(),

        version: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        entry: z.string().min(1),
        subdirectory: z.string().min(1).optional(),
        kernel: z.string().min(1).optional(),
        requires: z.array(z.string()).optional(),
        capabilities: CapabilitiesSchema.optional(),
    }),
    outputSchema: z.object({
        partId: z.string(),
        versionId: z.string(),
        /** True when this exact version and commit already existed and nothing was written. */
        existed: z.boolean(),
    }),
    rest: { method: 'POST', path: '/catalog/parts/:name/versions' },
    destructive: true,
    print: (o) => (o.existed ? 'already published' : `published ${o.versionId}`),
});

/**
 * Which versions satisfy these requirements.
 *
 * A **pure function over the catalog**: ranges in, exact versions out. That is deliberate and it is
 * the reason this is worth having as its own contract — the hardest logic in the system becomes the
 * most testable thing in it, answerable with no cluster and no bytes anywhere.
 *
 * It resolves; it does not deploy. What a site *runs* is a release, written separately, so a new
 * version appearing in the catalog changes nothing until someone composes with it. That is the
 * difference between a registry and a deploy, and it is why a site names a range rather than
 * following a branch.
 */
export const resolveContract = defineContract({
    domain: 'catalog',
    action: 'resolve',
    description: 'Resolve version requirements against published versions.',
    inputSchema: z.object({
        kernel: z.string().min(1).describe('A range, e.g. ^0.2'),
        parts: z.array(z.object({
            name: z.string().min(1),
            version: z.string().min(1).describe('A range, or * for any'),
        })),
    }),
    outputSchema: z.object({
        kernel: z.object({ name: z.string(), version: z.string(), commit: z.string() }),
        parts: z.array(z.object({ name: z.string(), version: z.string(), commit: z.string() })),
        /**
         * Requirements nothing satisfies, named.
         *
         * Reported rather than thrown, because a caller resolving five parts wants all five answers.
         * Failing on the first turns one round trip into five.
         */
        unsatisfied: z.array(z.object({ name: z.string(), wanted: z.string(), reason: z.string() })),
    }),
    rest: { method: 'POST', path: '/catalog/resolve' },
    print: (o) => (o.unsatisfied.length === 0
        ? `kernel ${o.kernel.version}, ${String(o.parts.length)} part(s)`
        : `${String(o.unsatisfied.length)} unsatisfied`),
});

// ---------------------------------------------------------------------------- events

export const VersionPublishedSchema = z.object({
    partName: z.string(),
    version: z.string(),
    kind: PartKindSchema,
    commit: z.string(),
});

/**
 * A new version exists in the catalog.
 *
 * **Nothing deploys on this.** A build going live on its own would change every site's composition
 * without anyone asking.
 */
/**
 * `scopedBy: 'global'` — **anyone may watch anything published, and that is the decision.**
 *
 * Typed deliberately rather than left off. An event with no scope is delivered to nobody, so
 * omitting this would have read as "not thought about yet" and behaved as "silently unsubscribable"
 * — which is what it did until 2026-09-06.
 *
 * Global is right because a published version *is* the public fact: a part name is one flat
 * namespace, anybody may resolve a range against it, and a marketplace that hid what was published
 * would be a marketplace nobody could browse. What is not public is the source behind it, and that
 * is `part.repository`, which is not in this payload.
 */
export const versionPublishedEvent = defineEvent('catalog.version_published', VersionPublishedSchema, {
    scopedBy: 'global',
});
