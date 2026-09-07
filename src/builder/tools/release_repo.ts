/**
 * `builder.release_repo` — every part a repository declares, in an order that composes.
 *
 * Because a repository is not one part. mesh-core builds seven from one commit, and releasing them
 * by hand is both the loop this replaces and a trap: a part declares a kernel range, so a kernel
 * released *after* the parts written against it leaves a set nobody can compose until somebody
 * notices and runs the whole thing again.
 *
 * Kernels first, then the rest. Each part is released at the same branch, so every version in one
 * answer comes from the same code.
 */

import { z, type IServiceContext } from '@flybyme/mesh';

import type { BuilderService } from '../builder.service.js';
import { releaseRepoContract } from '../contracts/artifact.contract.js';

type Input = z.infer<typeof releaseRepoContract['inputSchema']>;
type Output = z.infer<typeof releaseRepoContract['outputSchema']>;

export async function builder_release_repo(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    // Whose parts these are is settled by `release_part` for each one. Finding them is a read of a
    // collection that is public anyway, so there is nothing to check here that is not checked there.
    const parts = await ctx.call('part.find', {
        query: { repository: input.repository }, limit: 200,
    });

    const ordered = [...parts].sort((a, b) => {
        if (a.kind === b.kind) return a.name < b.name ? -1 : 1;
        return a.kind === 'kernel' ? -1 : b.kind === 'kernel' ? 1 : a.name < b.name ? -1 : 1;
    });

    const released: Output['released'] = [];
    const failed: Output['failed'] = [];

    for (const part of ordered) {
        try {
            const result = await ctx.call('builder.release_part', {
                part: part.name,
                bump: input.bump,
                ...(input.branch === undefined ? {} : { branch: input.branch }),
                ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
            });

            released.push({
                part: result.part,
                version: result.version,
                commit: result.commit,
                ...(result.artifactDigest === undefined ? {} : { artifactDigest: result.artifactDigest }),
                cached: result.cached,
            });
        } catch (error) {
            /**
             * Collected, not thrown.
             *
             * Seven parts should give seven answers. Stopping on the first turns one call into
             * seven and — worse — leaves the repository half-released, with some parts at a new
             * commit and some not, which is the state that is hardest to reason about afterwards.
             */
            failed.push({
                part: part.name,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (failed.length > 0) {
        ctx.logger.warn(
            `[builder] ${input.repository}: ${String(released.length)} released, ` +
            `${String(failed.length)} failed — ${failed.map((f) => f.part).join(', ')}`,
        );
    }

    return { repository: input.repository, released, failed };
}
