import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { ImportArtifactInput, RequestBuildOutput } from '../contracts/artifact.contract.js';
import { artifactFolder } from '../methods/artifacts.js';
import { hashOutput } from '../methods/build.js';
import { storeArtifact } from '../methods/artifactStore.js';

/** A path inside a build: relative, forward slashes, no way out of the build's folder. */
function safeRelative(p: string): boolean {
    return !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** See `artifactImportContract` (contracts/artifact.contract.ts). */
export async function importBuild(input: ImportArtifactInput, ctx: IServiceContext): Promise<RequestBuildOutput> {
    const part = await ctx.db('serve.part').resolve({ id: input.partId });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${input.partId}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind === 'kernel') {
        // A kernel build bakes in drivers the record would have to name; not supported here yet.
        throw new MeshError({ message: `"${part.key}" is a kernel; importing kernel builds is not supported.`, code: 'BAD_REQUEST', status: 400 });
    }

    const contents = new Map<string, Buffer>();
    for (const file of input.files) {
        if (!safeRelative(file.path)) {
            throw new MeshError({ message: `"${file.path}" is not a path inside a build.`, code: 'BAD_REQUEST', status: 400 });
        }
        if (contents.has(file.path)) {
            throw new MeshError({ message: `"${file.path}" is in the build twice.`, code: 'BAD_REQUEST', status: 400 });
        }
        contents.set(file.path, Buffer.from(file.contentBase64, 'base64'));
    }

    // The builder's own function, over the files as received: the build is what it says, or nothing.
    const { hash, assets } = hashOutput(contents);
    if (hash !== input.hash) {
        throw new MeshError({ message: `The files hash to ${hash}, not ${input.hash}: not the build it claims to be.`, code: 'BAD_REQUEST', status: 400 });
    }

    // Stored exactly where a queue build lands, under its content hash; written to a temporary
    // folder and renamed in, so no reader ever sees half a build. Already here: left as it is.
    const finalDir = artifactFolder(hash, ctx.nodeID);
    const present = await fs.access(finalDir).then(() => true, () => false);
    if (!present) {
        const staging = `${finalDir}.importing-${crypto.randomUUID()}`;
        try {
            for (const [relPath, content] of contents) {
                const destination = path.join(staging, ...relPath.split('/'));
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, content);
            }
            await fs.rename(staging, finalDir).catch(async (err: unknown) => {
                // Another import of the same hash won the race: identical content, keep theirs.
                if (!(await fs.access(finalDir).then(() => true, () => false))) throw err;
            });
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
    }

    // Kept in the database too, like a queue build (methods/artifactStore.ts).
    await storeArtifact(ctx.broker, hash, assets.map((a) => a.url), ctx.nodeID);

    const artifact = await ctx.db('serve.artifact').create({
        tenantId: part.tenantId,
        partId: part.id,
        ref: input.ref,
        commit: input.commit,
        status: 'success',
        hash,
        assets,
        duration: 0,
        builtOn: ctx.nodeID,
        imported: true,
    });
    if (input.wants !== undefined) await ctx.db('serve.part').update({ id: part.id, wants: input.wants });
    if (input.pin) await ctx.db('serve.part').update({ id: part.id, artifactId: artifact.id });

    ctx.logger.info(`[serve.artifact] imported ${hash.slice(0, 12)} for "${part.key}" at ${input.commit.slice(0, 7)}${input.pin ? ', pinned' : ''}`);
    ctx.emit('serve.artifact.built', { tenantId: part.tenantId, artifact, hash, assets });
    return artifact;
}
