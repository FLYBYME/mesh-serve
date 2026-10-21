import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';

import type { ImportFinishInput, ImportPieceInput } from '../contracts/artifact.contract.js';

/** One piece's bytes before base64: ~933 KB once encoded, under import_piece's 1 MB limit. */
export const PIECE_BYTES = 700 * 1024;

/** A random id naming one import's pieces. */
export function newUploadId(): string {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * One file of a build, gzipped and sent as serve.artifact.import_piece calls through `send`, one
 * after another. Answers the file's line for import_finish.
 */
export async function sendFile(
    uploadId: string,
    relPath: string,
    content: Buffer,
    send: (piece: ImportPieceInput) => Promise<unknown>,
): Promise<ImportFinishInput['files'][number]> {
    const gzipped = gzipSync(content);
    const pieces = Math.max(1, Math.ceil(gzipped.length / PIECE_BYTES));
    for (let index = 0; index < pieces; index++) {
        const data = gzipped.subarray(index * PIECE_BYTES, (index + 1) * PIECE_BYTES).toString('base64');
        await send({ uploadId, path: relPath, index, data });
    }

    return { path: relPath, pieces, sha256: crypto.createHash('sha256').update(gzipped).digest('hex') };
}
