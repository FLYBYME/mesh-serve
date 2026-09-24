import { MeshError } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { Artifact } from '../contracts/artifact.contract.js';

/** The scope `ctx.db` takes -- mesh does not export its meta type by name. */
type DbMeta = Parameters<IServiceContext['db']>[1];

/** An artifact that can actually be loaded: a successful build, so it has a hash to find its files by. */
export interface RunnableArtifact {
    artifact: Artifact;
    hash: string;
}

/**
 * `artifactId` must name a *successful* build of *this* part. Checked when the pin is set
 * (serve.part.update) and again when it is used (serve.part.start), since an artifact row can be
 * changed between the two and a start must never load another part's code.
 */
export async function resolvePinnedArtifact(
    ctx: IServiceContext,
    partId: string,
    artifactId: string,
    meta?: DbMeta,
): Promise<RunnableArtifact> {
    const artifact = await ctx.db('serve.artifact', meta).resolve({ id: artifactId });
    if (artifact === undefined) {
        throw new MeshError({ message: `No artifact "${artifactId}".`, code: 'NOT_FOUND', status: 404 });
    }
    if (artifact.partId !== partId) {
        throw new MeshError({
            message: `Artifact "${artifactId}" is a build of part "${artifact.partId}", not "${partId}".`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }
    if (artifact.status !== 'success' || artifact.hash === undefined) {
        throw new MeshError({
            message: `Artifact "${artifactId}" is "${artifact.status}", not a successful build${artifact.error ? `: ${artifact.error}` : ''}.`,
            code: 'CONFLICT',
            status: 409,
        });
    }
    return { artifact, hash: artifact.hash };
}

/**
 * Which build a service part runs: its pinned `artifactId`, exactly. Only a part with no pin --
 * one created before pinning existed -- falls back to the newest successful build, the rule every
 * start used to follow, under which any new build silently became the next thing to run.
 */
export async function artifactToRun(
    ctx: IServiceContext,
    part: { id: string; key: string; artifactId?: string | undefined },
    meta: DbMeta,
): Promise<RunnableArtifact> {
    if (part.artifactId !== undefined) {
        return resolvePinnedArtifact(ctx, part.id, part.artifactId, meta);
    }

    // Same "latest successful artifact" query compose.ts's own latestArtifact already uses.
    const [latest] = await ctx.db('serve.artifact', meta).find({
        query: { partId: part.id, status: 'success' },
        sort: '-createdAt',
        limit: 1,
    });
    if (latest === undefined || latest.hash === undefined) {
        throw new MeshError({
            message: `No successful build for "${part.key}". Build it first with serve.artifact.requestBuild.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }
    return { artifact: latest, hash: latest.hash };
}
