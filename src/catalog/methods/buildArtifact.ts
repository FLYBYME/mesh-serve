import type { IServiceBroker } from '@flybyme/mesh';

import type { Repo } from '../contracts/repo.contract.js';
import type { Part } from '../contracts/part.contract.js';
import type { Artifact } from '../contracts/artifact.contract.js';
import { buildPart, buildKernel, buildService } from './build.js';

/**
 * Building one artifact, and the two lookups it needs.
 *
 * Plain functions taking a broker, rather than methods on a class holding one. They were private
 * to `CatalogService` -- except `buildArtifact`, which had to be made public purely so
 * `tools/build.ts` could reach it, with a comment explaining that a handler in its own file is not
 * part of the class's lexical body. That whole problem was an artifact of the class existing.
 */
async function resolveDrivers(broker: IServiceBroker, artifact: Artifact): Promise<{ part: Part; repo: Repo }[]> {
    const meta = { tenant_id: artifact.tenantId };
    const resolved: { part: Part; repo: Repo }[] = [];
    for (const key of artifact.drivers ?? []) {
        const driverPart = await broker.call('serve.part.find_one', {
            query: { key, tenantId: artifact.tenantId },
        }, { meta });
        if (driverPart === undefined) {
            throw new Error(`No driver part "${key}".`);
        }
        const driverRepo = await broker.call('serve.repo.resolve', { id: driverPart.repoId }, { meta });
        if (driverRepo === undefined) {
            throw new Error(`No repo "${driverPart.repoId}" for driver "${key}".`);
        }
        resolved.push({ part: driverPart, repo: driverRepo });
    }
    return resolved;
}

/**
 * Every other part's declared `imports` specifier, so a non-kernel build externalizes whatever
 * it actually references instead of inlining a second copy of code the page loads separately.
 * Broad on purpose: a part that doesn't import a given specifier is unaffected by it being
 * listed, since esbuild only externalizes what a build's own module graph actually references.
 */
async function resolveExternals(broker: IServiceBroker, part: Part): Promise<string[]> {
    const others = await broker.call('serve.part.find', {
        query: { tenantId: part.tenantId },
    }, { meta: { tenant_id: part.tenantId } });
    return others
        .filter((other) => other.id !== part.id && other.imports !== undefined)
        .map((other) => other.imports as string);
}

/** Public so tools/build.ts (the serve.artifact.build dispatch target) can call it -- same
 *  reasoning as cdn.service.ts's contentSecurityPolicy/maintenancePage: a tool handler in its
 *  own file isn't part of this class's lexical body, so `private` would refuse it. */
export async function buildArtifact(broker: IServiceBroker, artifact: Artifact): Promise<void> {
    const meta = { tenant_id: artifact.tenantId };

    await broker.call('serve.artifact.update', {
        id: artifact.id,
        status: 'running',
    }, { meta });

    try {
        const part = await broker.call('serve.part.resolve', {
            id: artifact.partId,
        }, { meta });
        if (part === undefined) {
            throw new Error(`No part "${artifact.partId}".`);
        }
        const repo = await broker.call('serve.repo.resolve', {
            id: part.repoId,
        }, { meta });
        if (repo === undefined) {
            throw new Error(`No repo "${part.repoId}".`);
        }

        const startedAt = Date.now();

        const { hash, assets, wants, commit } = part.kind === 'kernel'
            ? await buildKernel(part, repo, artifact.ref, await resolveDrivers(broker, artifact))
            : part.kind === 'service'
                ? await buildService(part, repo, artifact.ref)
                : await buildPart(part, repo, artifact.ref, await resolveExternals(broker, part));

        const duration = (Date.now() - startedAt) / 1000;

        const updatedArtifact = await broker.call('serve.artifact.update', {
            id: artifact.id,
            status: 'success',
            hash,
            assets,
            duration,
            builtOn: broker.nodeID,
            commit,
        }, { meta });

        // wants is resolved from the repo at build time (mesh.wants.json), not hand-edited --
        // refreshed on every successful build so it tracks the part's current code, same as
        // hash/assets do on the artifact.
        await broker.call('serve.part.update', { id: part.id, wants }, { meta });

        broker.emit('serve.artifact.built', {
            tenantId: artifact.tenantId,
            artifact: updatedArtifact,
            hash,
            assets,
        });

        broker.logger.debug(`Built artifact ${artifact.id} - ${hash} - ${duration}s`);

    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        broker.logger.error(`Build failed for artifact ${artifact.id}`, err);
        const updatedArtifact = await broker.call('serve.artifact.update', {
            id: artifact.id,
            status: 'failed',
            error,
        }, { meta });

        broker.emit('serve.artifact.buildFailed', {
            tenantId: artifact.tenantId,
            artifact: updatedArtifact,
            error,
        });
    }
}
