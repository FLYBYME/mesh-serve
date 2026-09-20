import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { type GetAssetInput, type GetAssetOutput } from '../contracts/artifact.contract.js';
import { contentTypeFor, artifactAssetPath } from '../methods/artifacts.js';

export async function getAsset(
    input: GetAssetInput,
    ctx: IServiceContext,
): Promise<GetAssetOutput> {
    const filePath = artifactAssetPath(input.artifactHash, input.path);

    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch {
        throw new MeshError({ message: `No asset at "${input.path}" in artifact "${input.artifactHash}".`, code: 'NOT_FOUND', status: 404 });
    }

    if (!stat.isFile()) {
        throw new MeshError({ message: `"${input.path}" is not a file.`, code: 'NOT_FOUND', status: 404 });
    }

    return {
        name: path.basename(input.path),
        path: input.path,
        contentType: contentTypeFor(input.path),
        contentLength: stat.size,
        size: stat.size,
        lastModified: stat.mtime.toUTCString(),
        eTag: `"${crypto.createHash('sha1').update(`${input.artifactHash}:${input.path}:${stat.mtimeMs}:${stat.size}`).digest('hex')}"`,
        fileExtension: path.extname(input.path) || undefined,
    };
}
