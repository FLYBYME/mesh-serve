import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type {
    ImportFinishInput,
    ImportPieceInput,
    ImportPieceOutput,
    RequestBuildOutput,
} from '../contracts/artifact.contract.js';
import { artifactFolder } from '../methods/artifacts.js';
import { hashFolder, type ArtifactAssetInput } from '../methods/build.js';
import { keepCopies } from '../methods/spreadArtifact.js';
import { MAX_FILE_PIECES } from '../schema/artifactPiece.js';

/** The most a build may unzip to: 256 MB, far over any part (the biggest is ~9 MB). */
const MAX_BUILD_BYTES = 256 * 1024 * 1024;

/** A path inside a build: relative, forward slashes, no way out of the build's folder. */
function safeRelative(p: string): boolean {
    return !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The caller's organization: the pieces are kept under it, and only it finishes them. */
function callerTenant(ctx: IServiceContext): { tenant_id: string } {
    // Flat (a node's own call) or on the user (a call made as an account), as the database reads it.
    const user: unknown = ctx.meta?.user;
    const onUser = typeof user === 'object' && user !== null && 'tenant_id' in user ? user.tenant_id : undefined;
    const tenantId = ctx.meta?.tenant_id ?? onUser;
    if (typeof tenantId !== 'string' || tenantId === '') {
        throw new MeshError({ message: 'Importing a build needs the organization it is sent by.', code: 'BAD_REQUEST', status: 400 });
    }

    return { tenant_id: tenantId };
}

/** See `artifactImportPieceContract` (contracts/artifact.contract.ts). */
export async function import_piece(input: ImportPieceInput, ctx: IServiceContext): Promise<ImportPieceOutput> {
    if (!safeRelative(input.path)) {
        throw new MeshError({ message: `"${input.path}" is not a path inside a build.`, code: 'BAD_REQUEST', status: 400 });
    }

    const meta = callerTenant(ctx);
    const pieces = ctx.db('serve.artifactPiece', meta);
    const earlier = await pieces.find({ query: { uploadId: input.uploadId, path: input.path, index: input.index }, fields: ['id'] });
    for (const old of earlier) {
        await pieces.delete({ id: old.id });
    }

    await pieces.create({ tenantId: meta.tenant_id, uploadId: input.uploadId, path: input.path, index: input.index, data: input.data });

    return { index: input.index, bytes: Buffer.from(input.data, 'base64').length };
}

/** Every piece of an import, removed: once it is in, or refused. */
async function forgetPieces(ctx: IServiceContext, meta: { tenant_id: string }, uploadId: string): Promise<void> {
    const pieces = ctx.db('serve.artifactPiece', meta);
    for (;;) {
        const left = await pieces.find({ query: { uploadId }, fields: ['id'], limit: 200 });
        if (left.length === 0) return;

        for (const piece of left) {
            await pieces.delete({ id: piece.id });
        }
    }
}

/**
 * One file of the build, from its pieces: joined, checked against its sha256 when given, unzipped,
 * and written under `staging`. Answers its size unzipped.
 */
async function writeFile(
    ctx: IServiceContext,
    meta: { tenant_id: string },
    uploadId: string,
    file: ImportFinishInput['files'][number],
    staging: string,
    room: number,
): Promise<number> {
    const pieces = await ctx.db('serve.artifactPiece', meta).find({ query: { uploadId, path: file.path }, sort: 'index', limit: MAX_FILE_PIECES + 1 });
    const missing = Array.from({ length: file.pieces }, (_, i) => i).filter((i) => !pieces.some((p) => p.index === i));
    if (missing.length > 0 || pieces.length !== file.pieces) {
        throw new MeshError({
            message: `${file.path} is not whole: ${pieces.length} piece(s) received for ${file.pieces}${missing.length > 0 ? `, missing ${missing.join(', ')}` : ''}.`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const gzipped = Buffer.concat(pieces.map((p) => Buffer.from(p.data, 'base64')));
    if (file.sha256 !== undefined) {
        const actual = crypto.createHash('sha256').update(gzipped).digest('hex');
        if (actual !== file.sha256) {
            throw new MeshError({ message: `${file.path}: its sha256 is ${actual}, not ${file.sha256}.`, code: 'BAD_REQUEST', status: 400 });
        }
    }

    let bytes: Buffer;
    try {
        bytes = gunzipSync(gzipped, { maxOutputLength: room });
    } catch (err: unknown) {
        throw new MeshError({ message: `${file.path} is not gzip, or the build unzips past ${MAX_BUILD_BYTES} bytes: ${err instanceof Error ? err.message : String(err)}`, code: 'BAD_REQUEST', status: 400 });
    }

    const destination = path.join(staging, ...file.path.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);

    return bytes.length;
}

/**
 * The build onto this node's disk: each file written to a staging folder as it is unzipped, then
 * the hash read back from disk, one file at a time; renamed in only when it is the build it claims
 * to be, so no reader ever sees half a build. Already here: left as it is. Answers its assets.
 */
async function store(input: ImportFinishInput, ctx: IServiceContext, meta: { tenant_id: string }, paths: readonly string[]): Promise<ArtifactAssetInput[]> {
    const finalDir = artifactFolder(input.hash, ctx.nodeID);
    const staging = `${finalDir}.importing-${crypto.randomUUID()}`;
    try {
        let total = 0;
        for (const file of input.files) {
            total += await writeFile(ctx, meta, input.uploadId, file, staging, MAX_BUILD_BYTES - total);
        }

        const hashed = await hashFolder(staging, paths);
        if (hashed.hash !== input.hash) {
            throw new MeshError({ message: `The files hash to ${hashed.hash}, not ${input.hash}: not the build it claims to be.`, code: 'BAD_REQUEST', status: 400 });
        }

        if (!(await fs.access(finalDir).then(() => true, () => false))) {
            await fs.rename(staging, finalDir).catch(async (err: unknown) => {
                // Another import of the same hash won the race: identical content, keep theirs.
                if (!(await fs.access(finalDir).then(() => true, () => false))) throw err;
            });
        }

        return hashed.assets;
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

/** See `artifactImportFinishContract` (contracts/artifact.contract.ts). */
export async function import_finish(input: ImportFinishInput, ctx: IServiceContext): Promise<RequestBuildOutput> {
    const meta = callerTenant(ctx);
    try {
        return await finish(input, ctx, meta);
    } finally {
        await forgetPieces(ctx, meta, input.uploadId);
    }
}

async function finish(input: ImportFinishInput, ctx: IServiceContext, meta: { tenant_id: string }): Promise<RequestBuildOutput> {
    const part = await ctx.db('serve.part').resolve({ id: input.partId });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.partId}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind === 'kernel') {
        // A kernel build bakes in drivers the record would have to name; not supported here yet.
        throw new MeshError({ message: `"${part.key}" is a kernel; importing kernel builds is not supported.`, code: 'BAD_REQUEST', status: 400 });
    }

    const paths = input.files.map((f) => f.path);
    for (const p of paths) {
        if (!safeRelative(p)) {
            throw new MeshError({ message: `"${p}" is not a path inside a build.`, code: 'BAD_REQUEST', status: 400 });
        }
    }
    const twice = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (twice.length > 0) {
        throw new MeshError({ message: `"${twice[0]}" is in the build twice.`, code: 'BAD_REQUEST', status: 400 });
    }

    const assets = await store(input, ctx, meta, paths);

    const artifact = await ctx.db('serve.artifact').create({
        tenantId: part.tenantId,
        partId: part.id,
        ref: input.ref,
        commit: input.commit,
        status: 'success',
        hash: input.hash,
        assets,
        duration: 0,
        builtOn: ctx.nodeID,
        imported: true,
    });
    // A second copy on another node's disk, as a queue build gets (methods/spreadArtifact.ts).
    await keepCopies(ctx.broker, { id: artifact.id, tenantId: part.tenantId, hash: input.hash, builtOn: ctx.nodeID });
    if (input.wants !== undefined) await ctx.db('serve.part').update({ id: part.id, wants: input.wants });
    if (input.pin) await ctx.db('serve.part').update({ id: part.id, artifactId: artifact.id });

    ctx.logger.info(`[serve.artifact] imported ${input.hash.slice(0, 12)} for "${part.key}" at ${input.commit.slice(0, 7)}${input.pin ? ', pinned' : ''}`);
    ctx.emit('serve.artifact.built', { tenantId: part.tenantId, artifact, hash: input.hash, assets });
    return artifact;
}
