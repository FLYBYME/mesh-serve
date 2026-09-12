/**
 * Where code comes from, and what a build was built from.
 *
 * **A source is a reference, never a path** (`spec/building.md` §8). A path resolves on exactly one
 * machine, which is honest for a laptop and wrong for a fleet — question **E4**.
 */

import { z } from '@flybyme/mesh';

/** Forty hex characters. A branch is not one, and §2 of this file explains why that matters. */
export const COMMIT = /^[0-9a-f]{40}$/;

export const SourceRefSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('git'),
        repository: z.string().min(1).describe('A URL any builder on any node can resolve'),
        ref: z.string().min(1).describe('Resolved to a commit before a build records it'),
        subdirectory: z.string().min(1).optional().describe("A monorepo's part, from the root"),
    }),
    z.object({
        kind: z.literal('archive'),
        url: z.string().min(1),
        digest: z.string().min(1).describe('What makes it cacheable, and checkable'),
    }),
]);

export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Everything that determines a build's output.
 *
 * **The input hash is taken over exactly this**, so anything that can change the bytes has to be in
 * here or the cache returns the wrong artifact — which is worse than no cache, because it is silent.
 */
export const BuildInputsSchema = z.object({
    source: SourceRefSchema,
    /** Which part of the repository, and what it is called. */
    partId: z.string().min(1),
    entry: z.string().min(1),
    kind: z.enum(['kernel', 'application', 'extension']),
    /** Specifiers left external, which changes what ends up in the bundle. */
    external: z.array(z.string()).default([]),
    /** The builder's own version. A different bundler is a different output. */
    builder: z.string().min(1),
});

export type BuildInputs = z.infer<typeof BuildInputsSchema>;
