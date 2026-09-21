import fs from 'node:fs/promises';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { type FetchAssetBytesInput, type FetchAssetBytesOutput } from '../contracts/artifact.contract.js';
import { artifactAssetPath } from '../methods/artifacts.js';

export async function fetchAssetBytes(
    input: FetchAssetBytesInput,
    ctx: IServiceContext,
): Promise<FetchAssetBytesOutput> {
    const filePath = artifactAssetPath(input.artifactHash, input.path, ctx.nodeID);

    let content: Buffer;
    try {
        content = await fs.readFile(filePath);
    } catch {
        throw new MeshError({ message: `No asset at "${input.path}" in artifact "${input.artifactHash}".`, code: 'NOT_FOUND', status: 404 });
    }

    return { contentBase64: content.toString('base64') };
}
