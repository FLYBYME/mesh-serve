/**
 * `builder.get_artifact` — one artifact, by content digest.
 *
 * A lookup, not a get: the digest is the artifact's identity but not its document id, because
 * `defineCrud` mints that and nothing can supply one. So the collection is queried on the field that
 * actually means something.
 *
 * This is the seam between the builder and every serving node. A cdn node holds a site's resolution,
 * which names digests, and needs a file list before it can answer a request — asking through a
 * contract rather than reading the collection is what lets the builder change how it stores things
 * without breaking the cdn.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { BuilderService } from '../builder.service.js';
import { getArtifactContract } from '../contracts/artifact.contract.js';

type Input = z.infer<typeof getArtifactContract['inputSchema']>;
type Output = z.infer<typeof getArtifactContract['outputSchema']>;

export async function builder_get_artifact(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const artifact = await ctx.call('artifact.find_one', { query: { digest: input.digest } });

    if (artifact === null || artifact === undefined) {
        // 404 rather than an empty answer. An artifact is immutable and addressed by its content, so
        // "not here" is a fact about this cluster rather than a temporary state a caller should
        // retry through — and a caller that got an empty object back would have to invent the same
        // error itself, less well.
        throw new ClientError(`No artifact with digest ${input.digest}.`, 'artifact_not_found', 404);
    }

    return artifact;
}
