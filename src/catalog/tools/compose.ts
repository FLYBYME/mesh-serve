import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { ComposeInput, ComposeOutput } from '../contracts/composition.contract.js';
import type { Part } from '../contracts/part.contract.js';
import type { CatalogService } from '../catalog.service.js';
import { computeReleaseHash } from '../methods/release.js';

function sameDrivers(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Resolves and returns the part named by `id`, verifying its kind matches what the caller of this
 * function expects it to be -- e.g. a composition's kernelPartKey pointing at something that is no
 * longer kind: kernel (someone changed it) fails here, loudly, rather than composing a release with
 * a kernel that will not boot.
 */
async function resolvePart(id: string, tenantId: string, kind: Part['kind'], ctx: IServiceContext): Promise<Part> {
    const meta = { tenant_id: tenantId };
    const part = await ctx.db('serve.part', meta).resolve({ id });
    if (part === undefined) {
        throw new MeshError({ message: `No part "${id}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (part.kind !== kind) {
        throw new MeshError({ message: `Part "${id}" is kind "${part.kind}", not "${kind}".`, code: 'BAD_REQUEST', status: 400 });
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
    const candidates = await ctx.db('serve.artifact', meta).find({
        query: { partId: part.id, status: 'success' },
        sort: '-createdAt',
    });

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
    const composition = await ctx.db('serve.composition').resolve({ id: input.id });
    if (composition === undefined) {
        throw new MeshError({ message: `No composition "${input.id}".`, code: 'NOT_FOUND', status: 404 });
    }
    const { tenantId } = composition;
    const meta = { tenant_id: tenantId };

    const kernelPart = await resolvePart(composition.kernelPartKey, tenantId, 'kernel', ctx);
    const kernelArtifact = await latestArtifact(kernelPart, tenantId, composition.drivers, ctx);

    const artifacts: ComposeOutput['artifacts'] = [kernelArtifact];

    if (composition.theme !== undefined) {
        const themePart = await resolvePart(composition.theme, tenantId, 'theme', ctx);
        artifacts.push(await latestArtifact(themePart, tenantId, undefined, ctx));
    }

    // Drivers are baked directly into the kernel's own bundle (buildKernel), not composed as a
    // separate artifact -- nothing to resolve here for them beyond the drivers-match check above.
    // Services aren't part of a release at all: they're started independently via serve.part.start,
    // never shipped to a browser, so composition.services is never touched here either.

    for (const id of [...composition.extensions, ...composition.applications]) {
        const part = await ctx.db('serve.part', meta).resolve({ id });
        if (part === undefined) {
            throw new MeshError({ message: `No part "${id}".`, code: 'NOT_FOUND', status: 404 });
        }
        if (part.kind !== 'application' && part.kind !== 'extension') {
            throw new MeshError({ message: `Part "${id}" is kind "${part.kind}", not application or extension.`, code: 'BAD_REQUEST', status: 400 });
        }
        artifacts.push(await latestArtifact(part, tenantId, undefined, ctx));
    }

    artifacts.sort((a, b) => a.id.localeCompare(b.id));

    const hash = computeReleaseHash(composition.id, artifacts);

    const existing = await ctx.db('serve.release', meta).findOne({ query: { hash } });
    if (existing !== undefined) {
        return existing;
    }

    return ctx.db('serve.release', meta).create({
        tenantId,
        compositionId: composition.id,
        hash,
        artifacts,
    });
}
