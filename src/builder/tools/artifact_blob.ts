/**
 * `builder.artifact_blob` — one file's bytes, by content digest.
 *
 * The only way content leaves the builder, and **one hop per file per node**: a serving node caches
 * by digest, and a digest can never come to mean different bytes, so a cold cache is slower rather
 * than wrong.
 *
 * Base64, because the wire is JSON. That is a 33% overhead on a call made once per file per node
 * for its lifetime, which is the right thing to trade against a second transport nobody else needs.
 */

import { z, type IServiceContext } from '@flybyme/mesh';

import type { BuilderService } from '../builder.service.js';
import { artifactBlobContract } from '../contracts/artifact.contract.js';

type Input = z.infer<typeof artifactBlobContract['inputSchema']>;
type Output = z.infer<typeof artifactBlobContract['outputSchema']>;

export async function builder_artifact_blob(
    this: BuilderService,
    input: Input,
    _ctx: IServiceContext,
): Promise<Output> {
    const content = await this.blobs.get(input.digest);

    // Absent rather than an error: "this node does not hold it" is an ordinary answer, and the
    // caller's next move — ask another node — is the same either way. An error would make a normal
    // cache miss look like a fault.
    return content === undefined
        ? { size: 0 }
        : { content: content.toString('base64'), size: content.length };
}
