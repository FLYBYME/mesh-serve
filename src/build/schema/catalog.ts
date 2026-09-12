/**
 * Repositories, parts, versions and releases.
 *
 * `spec/building.md` §1. Five nouns for what is casually called *deploying*, and each separation
 * earns its place:
 *
 * - **a version is not an artifact** — a version names a commit, an artifact is the bytes, and the
 *   bytes can be `gone` while the version stays correct
 * - **a release is not a deployment** — composing produces a release, pointing a hostname at one is
 *   a separate act, and that separation is what makes a rollback picking a row from a list
 */

import { z } from '@flybyme/mesh';

/**
 * A git remote this platform knows about.
 *
 * **The largest change these specs asked for.** It was a *field on every part* — a URL repeated on
 * each part from the same place, with nothing keeping them consistent — so *what repositories does
 * this cluster know about* could only be answered by reading every part and taking distinct values,
 * and a repository could not be registered before it was imported.
 */
export const RepositorySchema = z.object({
    organizationId: z.string().min(1).describe('The owner. What makes the namespace work'),
    name: z.string().min(1).describe('Unique within the organization, not globally'),
    url: z.string().min(1).describe('A reference any builder on any node can resolve'),
    defaultBranch: z.string().min(1).default('HEAD'),
    subdirectory: z.string().min(1).optional().describe("Where the descriptor lives in a monorepo"),

    /**
     * **A reference to a credential, never a credential.**
     *
     * A private repository needs one, and a collection readable by an organization is not where it
     * lives. What this references is question **B4**, and it is unanswered — so nothing reads this
     * yet, and it is here to stop somebody putting a token in a string field instead.
     */
    credentialRef: z.string().min(1).optional(),

    /** When the descriptor was last read. `undefined` means registered and never imported. */
    importedAt: z.number().optional(),
});

export type Repository = z.infer<typeof RepositorySchema>;

export const PartKindSchema = z.enum(['kernel', 'application', 'extension']);
export type PartKind = z.infer<typeof PartKindSchema>;

/**
 * Something publishable that lives in a repository.
 *
 * **One repository holds many parts**, which was already true in practice and which the data model
 * did not say: `mesh-core.git` produces `ui`, `auth` and `identity`.
 */
export const PartSchema = z.object({
    repositoryId: z.string().min(1),
    organizationId: z.string().min(1).describe('Denormalised from the repository, so a find can scope'),

    /**
     * Unique **within its repository**, not globally.
     *
     * That one word is the whole fix for the part namespace. A second organization importing a
     * repository whose part names were taken used to be refused outright, with a whole error message
     * about it; now `platform/kernel` and `flowboard/kernel` coexist and the constraint stops
     * existing rather than getting a better message.
     */
    name: z.string().min(1),
    kind: PartKindSchema,
    entry: z.string().min(1).describe('Where the bundle starts, from the repository root'),

    /** The specifier other parts import this one as, when it exports a vocabulary. */
    importAs: z.string().min(1).optional(),
    /**
     * Other parts this one imports, **by name within the same repository**.
     *
     * Names rather than row ids, because that is what a descriptor can honestly write: the author of
     * `mesh-core` knows their `identity` part needs their `auth` part, and cannot know the id a row
     * will be given on a cluster they have never seen. Resolving the name is the platform's job, at
     * the moment it is needed, where the failure can name both parts.
     */
    requiredParts: z.array(z.string()).default([]),

    description: z.string().default(''),
    license: z.string().optional(),
});

export type Part = z.infer<typeof PartSchema>;

/**
 * One publication of a part, at a commit.
 *
 * **A version is minted, never declared.** A repository holding its own version number is one that
 * must be edited to ship, and a number that can be spent twice.
 */
export const VersionSchema = z.object({
    partId: z.string().min(1),
    organizationId: z.string().min(1),

    version: z.string().min(1).describe('Minted by the platform, monotonic per part'),
    commit: z.string().regex(/^[0-9a-f]{40}$/).describe('Never a branch — see inputHash'),

    /** Set once the build succeeds. Absent while `declared`. */
    artifactDigest: z.string().min(1).optional(),

    /**
     * `declared` → `built` → `gone`.
     *
     * **`gone` is not an error.** The artifact was built and no edge holds the bytes any more, which
     * is the signal to rebuild from `commit` — safe because the build is deterministic, so several
     * edges discovering it at once all produce the same digest.
     */
    state: z.enum(['declared', 'built', 'gone']).default('declared'),

    publishedAt: z.number(),
});

export type Version = z.infer<typeof VersionSchema>;

/** One part pinned into a release: the version for a person, the digest for a machine. */
export const PinnedSchema = z.object({
    partId: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().min(1),
    /** The specifier the page's import map binds to this artifact. */
    importAs: z.string().min(1).optional(),
});

export type Pinned = z.infer<typeof PinnedSchema>;

/**
 * A named set of versions that compose.
 *
 * **A composition is refused at compose time, not in a browser.** A release naming a part it does
 * not have, or a part whose requirement is unmet, fails when it is built — the failure moves from a
 * blank page to a build, which is the whole point of composing at all.
 */
export const ReleaseSchema = z.object({
    organizationId: z.string().min(1),

    /** Derived from the contents, so composing the same parts twice is the same release. */
    hash: z.string().min(1),
    name: z.string().default(''),

    /** Exactly one, and every other part is bundled against it. */
    kernel: PinnedSchema,
    parts: z.array(PinnedSchema).default([]),

    composedAt: z.number(),
});

export type Release = z.infer<typeof ReleaseSchema>;
