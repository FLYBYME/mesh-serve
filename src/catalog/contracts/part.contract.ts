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

import {
    CapabilitiesSchema, PartDeclarationSchema, PartKindSchema, PartSchema, PartVersionSchema,
} from '../schema/part.js';

// ---------------------------------------------------------------------------- collections

export const partCrud = defineCrud('part', PartSchema, {
    pluralPath: 'parts',

    // A part name is what a site writes to install one, so it is one namespace for everybody.
    // Flat and global, which is a decision with a cost recorded on `PartSchema.name`: two publishers
    // both wanting `auth` collide, and there is no scoping yet.
    unique: [{ fields: 'name', scope: 'global' }],

    /**
     * **Reads only, and the catalog is the one collection where an unbounded `find` is correct.**
     *
     * Everywhere else in this repository the rule is *never expose an unbounded find*, because a
     * `site` find enumerates every hostname on the platform. A part is the opposite: the whole
     * purpose of a catalog is that anyone may see what has been published and resolve a range
     * against it. A marketplace that hid its own contents would not be one — which is the same
     * reasoning that made `catalog.version_published` a global event (F1).
     *
     * `create`, `update` and `delete` stay internal. A part is created by `catalog.publish`, which
     * checks the publisher and enforces version immutability; a second door into this collection
     * would be a door around both of those. Roadmap F2.
     */
    visibility: { find: 'public', findOne: 'public', get: 'public', count: 'public' },
    // Reading and writing a part record touches no other domain. Publishing a version does — it
    // checks the publisher and refuses a changed commit — and that is `publish`'s job, not a hooked
    // create.
    dependencies: [],
});

export const partVersionCrud = defineCrud('partVersion', PartVersionSchema, {
    pluralPath: 'part-versions',

    /**
     * **A part's source commit is what a row *is*, and this is what makes that true.**
     *
     * It was `['partName', 'version']` until 2026-09-07, which made a version number an identity and
     * therefore a thing that could be spent — see `PartVersionSchema.version` for why that had to
     * go. Keyed on the commit, the same database guarantee does more useful work: two publishes of
     * one commit racing each other still cannot produce two rows, and a re-publish under a label
     * that already exists is an ordinary write rather than a 409.
     *
     * Global, because a commit is global: a repository at `abc123…` is the same code for everybody,
     * which is the point of publishing it.
     *
     * **Live databases carry the old index.** A cluster that ran the previous version has a unique
     * index on `(partName, version)` that this declaration does not replace, and it will keep
     * refusing the second commit under one label until it is dropped. See `scripts/`.
     */
    unique: [{ fields: ['partName', 'commit'], scope: 'global' }],

    /** Reads only, for the same reason as `part` above. Versions are what a range resolves against. */
    visibility: { find: 'public', findOne: 'public', get: 'public', count: 'public' },

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
        /**
         * Optional assertion of who publishes this part.
         *
         * The server derives the publisher from the caller's authenticated identity (`ctx.meta`),
         * never from this field. If provided, it is checked as an assertion and rejected if it
         * disagrees with the caller's organization.
         */
        publisher: z.string().min(1).optional(),

        // Presentation. Written to the `part` row on every publish, because a description is
        // fixable without minting a version — see `PartSchema`.
        description: z.string().optional(),
        homepage: z.string().optional(),
        license: z.string().optional(),
        keywords: z.array(z.string()).optional(),
        icon: z.string().optional(),

        version: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        entry: z.string().min(1),
        subdirectory: z.string().min(1).optional(),
        kernel: z.string().min(1).optional(),
        requires: z.array(z.string()).optional(),
        capabilities: CapabilitiesSchema.optional(),
        /** Frozen with the version, unlike everything above. */
        changelog: z.string().optional(),
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
 * Declare a part — what it is, where its source is, and what it builds — without publishing one.
 *
 * **The endpoint that replaces editing `mesh.json`.** A part exists here before any version of it
 * does, which is the ordering the previous model could not express: `catalog.publish` created the
 * part row as a side effect of publishing a version, so there was no way to say *this part exists
 * and here is how to build it* and then ask the platform to go and do it. That gap is why every
 * release started with a text editor.
 *
 * Idempotent by name, and the same identity rules apply as everywhere else: `kind` is fixed at
 * creation, `publisher` comes from the caller, and neither can be changed by asking again.
 */
export const declareContract = defineContract({
    domain: 'catalog',
    action: 'declare',
    description: 'Create or update a part and how it builds, without publishing a version.',
    dependencies: [],
    inputSchema: z.object({
        name: z.string().min(1),
        kind: PartKindSchema,
        repository: z.string().min(1),
        declaration: PartDeclarationSchema,

        // Presentation, all optional and all followed rather than overwritten: a field left out is
        // left alone, so a console that knows about `description` and not `icon` cannot erase one.
        description: z.string().optional(),
        homepage: z.string().optional(),
        license: z.string().optional(),
        keywords: z.array(z.string()).optional(),
        icon: z.string().optional(),
    }),
    outputSchema: z.object({
        partId: z.string(),
        name: z.string(),
        /** False when this created the part. */
        existed: z.boolean(),
    }),
    rest: { method: 'PUT', path: '/catalog/parts/:name' },
    /**
     * **Exposable, and the gate is the site's.** Declaring a part is how an operator adds one from
     * the console, which is the whole point — but it writes a row that says which repository a
     * builder will clone with whatever credential it holds, so no site should put this behind
     * anything less than `operator`.
     */
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.name} ${o.existed ? 'updated' : 'declared'}`,
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
    /**
     * Public and **pure** — ranges in, versions out, no write anywhere. A release creator has to
     * show what `^1.0` will actually resolve to *before* composing, or the operator is composing
     * blind and reading the answer out of the result. Roadmap F2.
     */
    visibility: 'public',
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
