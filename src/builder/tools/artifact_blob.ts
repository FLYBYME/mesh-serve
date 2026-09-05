/**
 * `builder.artifact_blob` — where to download one file of an artifact.
 *
 * **The mesh answers questions; content moves over HTTP.** This returns a URL rather than bytes: a
 * kernel bundle is megabytes, base64 adds a third again, and the whole of it would travel as one
 * JSON-encoded broker message held complete in memory at both ends — on a transport meant for
 * control messages.
 *
 * The caller then fetches it the ordinary way, streaming, in parallel, with caching and range
 * requests it did not have to invent. And because the digest *is* the content, the URL is stable
 * forever and a node that already holds those bytes never asks at all.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { BuilderService } from '../builder.service.js';
import { artifactBlobContract } from '../contracts/artifact.contract.js';

type Input = z.infer<typeof artifactBlobContract['inputSchema']>;
type Output = z.infer<typeof artifactBlobContract['outputSchema']>;

export async function builder_artifact_blob(
    this: BuilderService,
    input: Input,
    _ctx: IServiceContext,
): Promise<Output> {
    const held = await this.blobs.stat(input.digest);

    if (held === undefined) {
        // 404 rather than a URL that will 404 later. Handing back an address for content this
        // cluster does not have moves the failure to whoever fetches it, at which point the only
        // symptom is a missing module in someone's browser.
        throw new ClientError(`No blob with digest ${input.digest}.`, 'blob_not_found', 404);
    }

    return { url: this.blobUrl(input.digest), size: held.size };
}
