/**
 * A build: a source reference in, an artifact out.
 *
 * The build record exists for one reason — **a failed build with no log is a bug report nobody can
 * act on**, and the workspace it failed in was destroyed on the way out. Everything else about a
 * successful build is already in the artifact.
 */

import { z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- source

/**
 * Where a build gets its input. A *reference*, resolvable by any builder anywhere.
 *
 * The builder fetches it into a scratch workspace it owns and destroys afterwards, which is what
 * makes "the code need not be local to the server" true rather than aspirational.
 */
export const SourceRefSchema = z.union([
    z.object({
        kind: z.literal('git'),
        repository: z.string().min(1),
        /**
         * **A commit, always.**
         *
         * A branch hashes to itself forever while the code underneath it changes, so a build cached
         * on one would serve a stale artifact indefinitely — which is worse than not caching at all.
         * A branch or tag is resolved to a commit *before* a build record exists, so the record
         * cannot hold an unresolved ref even briefly.
         */
        ref: z.string().regex(/^[0-9a-f]{40}$/),
        /** Build from a subdirectory, for a monorepo. A name within the repository, not a path. */
        subdirectory: z.string().min(1).optional(),
    }).strict(),
    z.object({
        kind: z.literal('archive'),
        url: z.string().min(1),
        /** So a builder can refuse an archive that changed under it. */
        digest: z.string().min(1),
    }).strict(),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

// ---------------------------------------------------------------------------- the build

export const BuildStateSchema = z.enum(['queued', 'fetching', 'building', 'succeeded', 'failed']);
export type BuildState = z.infer<typeof BuildStateSchema>;

export const BuildSchema = z.object({
    // No `id`: `defineCrud` adds it, and declaring it here is refused outright — document ids belong
    // to the database layer.
    source: SourceRefSchema,

    /**
     * The hash of everything that determines the output.
     *
     * Same commit, same builder, same entry: nothing runs, not even a clone. This names precisely
     * what "same" means, so the answer does not drift as inputs are added — and every input is
     * inside the hash rather than beside it.
     *
     * **Policy is not an input.** It was, in the predecessor, because policy was frozen into the
     * bundle at build time; it is enforced at the cdn now, so one artifact serves every site that
     * chooses it and a policy change rebuilds nothing.
     */
    inputHash: z.string().min(1),

    state: BuildStateSchema,
    startedAt: z.date(),
    finishedAt: z.date().optional(),

    /** Present once it succeeded. → artifact.digest. */
    artifactDigest: z.string().min(1).optional(),
    error: z.string().optional(),
    /** Travels with the failure, because the workspace it happened in is already gone. */
    log: z.string().optional(),
});
export type Build = z.infer<typeof BuildSchema>;

/**
 * What goes into the input hash.
 *
 * Not a stored record — the hash is stored, and this is the shape it is computed from. Named so that
 * adding an input is a change to a type rather than a line somebody remembers to add.
 */
export interface BuildInputs {
    readonly source: SourceRef;
    /** The entry point within the source. Changing it changes the output. */
    readonly entry: string;
    /** The builder's own version: a change here can change the output too. */
    readonly builderVersion: string;
}
