/**
 * An artifact: bytes, and a hash.
 *
 * Two rules hold this whole file up, and both exist because the generation before this one broke
 * them:
 *
 * - **Source is a reference, never a path.** The predecessor's build input was `sourceDir`, a
 *   directory on the building node's disk, so nothing could be built from anywhere else.
 * - **An artifact is content, never a location.** Its artifact record was `filePath`, an absolute
 *   path on whichever node happened to build it, so nothing could move once built.
 *
 * There is deliberately no `path`, `dir` or `filePath` field here. A schema cannot stop someone
 * putting a path in a string, but it can stop the shape from inviting it.
 */

import { z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- files

/**
 * One file in an artifact.
 *
 * `path` is a name *within* the artifact — `index.js`, `assets/app.css` — which is why it is allowed
 * to be called a path at all. It says nothing about where the bytes are, and any node holding the
 * content can serve it under this name.
 */
export const ArtifactFileSchema = z.object({
    path: z.string().min(1),
    /** The file's own hash, so an unchanged file is neither re-stored nor re-fetched. */
    digest: z.string().min(1),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1),
});
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

// ---------------------------------------------------------------------------- what it was built against

/**
 * A dependency at the version that was actually linked, not the one that was asked for.
 *
 * `^1.2.0` is a wish; the installed version is the fact, and the point of this record is to be a
 * fact something else can compare against.
 *
 * **`commit` is the only identity that means anything for a git dependency.** Found by running the
 * first version of this against a real repository: `@flybyme/mesh-web` is installed as
 * `github:FLYBYME/mesh-web` and its `package.json` says `0.1.0`. It will say `0.1.0` on every build
 * forever, because nothing bumps the version of a package consumed from a branch — so `version`, the
 * field added specifically to catch a framework mismatch, was constant across every framework
 * change and would have caught nothing. The lockfile knows: `resolved` carries a `#<sha>` fragment.
 */
export const ResolvedDependencySchema = z.object({
    package: z.string().min(1),
    /** An exact version. Never a range. */
    version: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});
export type ResolvedDependency = z.infer<typeof ResolvedDependencySchema>;

// ---------------------------------------------------------------------------- what it provides

/**
 * The part an artifact contains.
 *
 * One, not many. An artifact is a part — that is what makes a part independently versioned,
 * independently cached and independently replaceable, and it is what stops a site rebuilding
 * everything to change one thing.
 *
 * `entry` is a name within the artifact, the same kind of name as `ArtifactFile.path`.
 */
export const DeclaredPartSchema = z.object({
    kind: z.enum(['kernel', 'application', 'extension']),
    /** Stable across builds. What a site's `parts` names when it says it loads this. */
    id: z.string().min(1),
    /** The version this build published. A part is chosen by this, so it is not optional. */
    version: z.string().min(1),
    entry: z.string().min(1),
});
export type DeclaredPart = z.infer<typeof DeclaredPartSchema>;

/**
 * What an artifact says it is — *declared*, in the sense of declared/desired/observed.
 *
 * **The artifact carries this rather than a registry computing it later**, so registering one is a
 * write rather than a compile, and an artifact copied to another node arrives already able to say
 * what it is.
 *
 * It is not a copy of the repository's descriptor. The descriptor is build *input* — what someone
 * asked for. This is build *output* — what was produced, with what was actually resolved.
 */
export const DeclarationSchema = z.object({
    part: DeclaredPartSchema,
    /**
     * The kernel version requirement this part was built against.
     *
     * Absent on a kernel artifact, which is the one thing that has no kernel. Present on every part,
     * because with parts built separately there is no longer a compiler that sees both sides: a part
     * built against 1.2 and loaded into a site serving 2.0 fails in someone's browser, and this is
     * the only thing standing in front of that.
     */
    kernel: z.string().min(1).optional(),
    /** Every contract this part calls, by key. A requirement — never a grant. See `mesh.json`. */
    requires: z.array(z.string().min(1)),

    /**
     * Other parts this one needs on the page.
     *
     * Carried on the artifact as well as in the catalog, for the same reason the declaration exists
     * at all: an artifact copied to another node arrives already able to say what it is. A node
     * holding the bytes can answer *what does this need* without a catalog lookup.
     */
    requiredParts: z.array(z.object({
        id: z.string().min(1),
        version: z.string().min(1),
        optional: z.boolean(),
    })).default([]),
    builtAgainst: z.array(ResolvedDependencySchema),
});
export type Declaration = z.infer<typeof DeclarationSchema>;

// ---------------------------------------------------------------------------- the artifact

/**
 * A built part, as content.
 *
 * `digest` addresses the whole set, so *is this the artifact I mean* is answerable without trusting
 * a name, and a node that already holds it can skip the fetch. Immutable once built: a new build is
 * a new artifact, never an edit of this one, which is what lets it be cached forever and what makes
 * its digest usable as a URL.
 */
export const ArtifactSchema = z.object({
    digest: z.string().min(1),
    files: z.array(ArtifactFileSchema).min(1),
    totalSize: z.number().int().nonnegative(),
    builtAt: z.date(),
    /** → build.id. For tracing back. Not needed to serve it. */
    buildId: z.string().min(1),
    declaration: DeclarationSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;
