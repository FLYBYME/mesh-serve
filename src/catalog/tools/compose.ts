import crypto from 'node:crypto';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { ComposeInput, ComposeOutput } from '../contracts/composition.contract.js';
import type { Part } from '../contracts/part.contract.js';
import type { CatalogService } from '../catalog.service.js';

function sameDrivers(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Resolves and returns the part named by `key`, verifying its kind matches what the caller of this
 * function expects it to be -- e.g. a composition's kernelPartKey pointing at something that is no
 * longer kind: kernel (someone changed it) fails here, loudly, rather than composing a release with
 * a kernel that will not boot.
 */
async function resolvePart(key: string, tenantId: string, kind: Part['kind'], ctx: IServiceContext): Promise<Part> {
    const meta = { tenant_id: tenantId };
    const part = await ctx.broker.call('serve.part.find_one', { query: { key, tenantId } }, { meta });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${key}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind !== kind) {
        throw new MeshError({ message: `Part "${key}" is kind "${part.kind}", not "${kind}".`, code: 'BAD_REQUEST', status: 400 });
    }
    return part;
}

/**
 * The most recent successful artifact for this part. For a kernel part, `drivers` must match the
 * composition's driver set exactly -- buildKernel bakes drivers into one bundle, so the same kernel
 * part built with a different driver set is a different, separately-pinnable artifact.
 */
async function latestArtifact(part: Part, tenantId: string, drivers: readonly string[] | undefined, ctx: IServiceContext) {
    const meta = { tenant_id: tenantId };
    const candidates = await ctx.broker.call('serve.artifact.find', {
        query: { partId: part.id, status: 'success' },
        sort: '-createdAt',
    }, { meta });

    const match = drivers === undefined
        ? candidates[0]
        : candidates.find((a) => sameDrivers(a.drivers ?? [], drivers));

    if (match === undefined || match.hash === undefined) {
        const driverNote = drivers === undefined ? '' : ` with drivers [${drivers.join(', ')}]`;
        throw new MeshError({
            message: `No successful artifact for part "${part.key}"${driverNote}. Build it first with serve.artifact.requestBuild.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }
    return match;
}

export async function compose(
    this: CatalogService,
    input: ComposeInput,
    ctx: IServiceContext,
): Promise<ComposeOutput> {
    const composition = await ctx.call('serve.composition.resolve', { id: input.id });
    if (composition === undefined) {
        throw new MeshError({ message: `No composition "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    const { tenantId } = composition;
    const meta = { tenant_id: tenantId };

    /**
     * MongoDB serializes an explicit `undefined` object property to BSON `null` when that object is
     * an array element (unlike a top-level document field, where mesh's `ignoreUndefined` connection
     * setting drops the key outright) -- so `{ imports: possiblyUndefined }` inside `releaseParts`
     * round-trips as `{ imports: null }`, which `releasePartSchema`'s plain `z.string().optional()`
     * then refuses on the next read. Omitting the key outright when there's nothing to put there
     * sidesteps it instead of loosening the schema to accept a null that means the same thing.
     */
    const importsField = (imports: string | undefined): { imports: string } | Record<string, never> =>
        imports === undefined ? {} : { imports };

    const kernelPart = await resolvePart(composition.kernelPartKey, tenantId, 'kernel', ctx);
    const kernelArtifact = await latestArtifact(kernelPart, tenantId, composition.drivers, ctx);

    const releaseParts: ComposeOutput['parts'] = [
        { partKey: kernelPart.key, kind: 'kernel', artifactHash: kernelArtifact.hash as string, ...importsField(kernelPart.imports) },
    ];

    if (composition.theme !== undefined) {
        const themePart = await resolvePart(composition.theme, tenantId, 'theme', ctx);
        const themeArtifact = await latestArtifact(themePart, tenantId, undefined, ctx);
        releaseParts.push({ partKey: themePart.key, kind: 'theme', artifactHash: themeArtifact.hash as string, ...importsField(themePart.imports) });
    }

    for (const key of composition.parts) {
        const part = await ctx.broker.call('serve.part.find_one', { query: { key, tenantId } }, { meta });
        if (part === undefined) {
            throw new MeshError({ message: `No part "${key}".`, code: 'NOT_FOUND', status: 404 });
        }
        if (part.kind !== 'application' && part.kind !== 'extension') {
            throw new MeshError({ message: `Part "${key}" is kind "${part.kind}", not application or extension.`, code: 'BAD_REQUEST', status: 400 });
        }
        const artifact = await latestArtifact(part, tenantId, undefined, ctx);
        releaseParts.push({ partKey: part.key, kind: part.kind, artifactHash: artifact.hash as string, ...importsField(part.imports) });
    }

    releaseParts.sort((a, b) => a.partKey.localeCompare(b.partKey));

    const hash = crypto.createHash('sha256')
        .update(JSON.stringify({ compositionId: composition.id, parts: releaseParts }))
        .digest('hex');

    const existing = await ctx.broker.call('serve.release.find_one', { query: { hash } }, { meta });
    if (existing !== undefined) {
        return existing;
    }

    return ctx.broker.call('serve.release.create', {
        tenantId,
        compositionId: composition.id,
        hash,
        parts: releaseParts,
    }, { meta });
}
