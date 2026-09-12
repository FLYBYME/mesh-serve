/**
 * An artifact: the bytes one build produced, named by their digest.
 *
 * **Immutable.** A new build is a new artifact, never an edit of this one — which is what lets it be
 * cached forever with no invalidation, and what makes its digest usable as a URL
 * (`spec/building.md` §4).
 */

import { z } from '@flybyme/mesh';

export const ArtifactFileSchema = z.object({
    path: z.string().min(1).describe('Relative, inside the artifact. Never an absolute path'),
    digest: z.string().min(1),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).describe('A browser refuses a module served as text/plain'),
});

export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

/**
 * What a build resolved, recorded.
 *
 * **`builtAgainst` is what makes a build explicable.** A bundle that behaves differently from
 * yesterday's has its resolved dependencies attached, with commits, so *what changed* is a diff
 * rather than an investigation.
 */
export const DeclarationSchema = z.object({
    kind: z.enum(['kernel', 'application', 'extension']),
    id: z.string().min(1),
    version: z.string().min(1),
    entry: z.string().min(1),
    /** Specifiers left external: the framework, and any part this one imports. */
    external: z.array(z.string()).default([]),
    builtAgainst: z.array(z.object({
        specifier: z.string().min(1),
        version: z.string().min(1),
        commit: z.string().optional(),
    })).default([]),
});

export type Declaration = z.infer<typeof DeclarationSchema>;

export const ArtifactSchema = z.object({
    /** The name. Content-addressed, so two nodes that built the same thing agree without asking. */
    digest: z.string().min(1),
    files: z.array(ArtifactFileSchema).min(1),
    totalSize: z.number().int().nonnegative(),
    builtAt: z.number(),
    /** Which attempt produced it, so a failure and its output can be joined up. */
    buildId: z.string().min(1).optional(),
    declaration: DeclarationSchema,

    /**
     * `available` or `gone`.
     *
     * **`gone` is an observed fact, never a desired state.** An edge's disk is a cache and a pod's
     * storage is deleted on restart, so the bytes disappearing is ordinary. It is the signal to
     * rebuild from the version's commit, which is safe because the build is deterministic.
     */
    state: z.enum(['available', 'gone']).default('available'),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
