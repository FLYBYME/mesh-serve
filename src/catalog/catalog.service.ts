import type { IServiceBroker, IServiceContext } from '@flybyme/mesh';
import { Database, MeshError, ServiceModule } from '@flybyme/mesh';

import { repoCrud, type Repo } from './contracts/repo.contract.js';
import { partCrud, type Part } from './contracts/part.contract.js';
import { compositionCrud, compositionComposeContract } from './contracts/composition.contract.js';
import { artifactCrud, artifactGetArtifactContract, artifactGetAssetContract, artifactRequestBuildContract, type Artifact } from './contracts/artifact.contract.js';
import { releaseCrud, releaseGetReleaseContract } from './contracts/release.contract.js';

import { getArtifact } from './tools/getArtifact.js';
import { getAsset } from './tools/getAsset.js';
import { getRelease } from './tools/getRelease.js';
import { requestBuild } from './tools/requestBuild.js';
import { compose } from './tools/compose.js';
import { buildPart, buildKernel } from './methods/build.js';

export class CatalogService extends ServiceModule {
    public readonly domain = 'serve.catalog';

    private broker!: IServiceBroker;
    private watchInterval: NodeJS.Timeout | undefined;

    constructor() {
        super();

        this.mountCrud(repoCrud);
        this.mountCrud(partCrud);
        this.mountCrud(compositionCrud);
        this.mountCrud(artifactCrud);
        this.mountCrud(releaseCrud);

        this.mountTool(artifactGetArtifactContract, getArtifact);
        this.mountTool(artifactGetAssetContract, getAsset);
        this.mountTool(artifactRequestBuildContract, requestBuild);
        this.mountTool(releaseGetReleaseContract, getRelease);
        this.mountTool(compositionComposeContract, compose);

        this.mountCrudHook('serve.part', 'create', {
            before: async (input, ctx) => {
                const { tenantId } = input as { tenantId: string };
                await this.validatePartKey(input as { key: string }, tenantId, ctx);
                return input;
            },
        });

        this.mountCrudHook('serve.part', 'update', {
            before: async (input, ctx) => {
                const { id, key } = input as { id: string; key?: string };
                if (key === undefined) {
                    return input;
                }
                const part = await ctx.call('serve.part.resolve', { id });
                if (part === undefined) {
                    throw new MeshError({ message: `No part "${id}".`, code: 'NOT_FOUND', status: 404 });
                }
                await this.validatePartKey({ key }, part.tenantId, ctx);
                return input;
            },
        });
    }

    /**
     * key is "org-slug/part-name" -- the org's own slug, not whatever the caller feels like typing,
     * so a part built by one org can't claim another org's namespace.
     */
    private async validatePartKey(input: { key: string }, tenantId: string, ctx: IServiceContext): Promise<void> {
        const org = await ctx.call('identity.organization.resolve', { id: tenantId });
        if (org === undefined) {
            throw new MeshError({ message: `No organization "${tenantId}".`, code: 'NOT_FOUND', status: 404 });
        }
        const slash = input.key.indexOf('/');
        const prefix = slash === -1 ? undefined : input.key.slice(0, slash);
        const name = slash === -1 ? undefined : input.key.slice(slash + 1);
        if (prefix !== org.slug || name === undefined || name.length === 0) {
            throw new MeshError({
                message: `key must be "${org.slug}/<part-name>", got "${input.key}".`,
                code: 'BAD_REQUEST',
                status: 400,
            });
        }
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        this.watchInterval = setInterval(() => {
            this.watchRelease().catch((err) => {
                this.broker.logger.error('watchRelease tick failed', err);
            });
        }, 1000 * 60);// 60 seconds
    }

    public async onStop(): Promise<void> {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
        }
    }

    /**
     * Scans for pending artifacts across every tenant -- there is no single tenant this job runs
     * as, so there is no meta.tenant_id that could ever be correct here. This is exactly the case
     * Database.repo() exists for, unlike every other call in this file (each of which resolves one
     * specific artifact/part/repo that already names its own tenant).
     */
    private async watchRelease(): Promise<void> {
        const db = this.broker.getProvider<Database>('database');
        const repo = db.repo(artifactCrud.get.outputSchema, 'serve.artifact');
        const pending = await repo.find({ query: { status: 'pending' } });
        for (const artifact of pending) {
            await this.buildArtifact(artifactCrud.get.outputSchema.parse(artifact));
        }
    }

    private async resolveDrivers(artifact: Artifact): Promise<{ part: Part; repo: Repo }[]> {
        const meta = { tenant_id: artifact.tenantId };
        const resolved: { part: Part; repo: Repo }[] = [];
        for (const key of artifact.drivers ?? []) {
            const driverPart = await this.broker.call('serve.part.find_one', {
                query: { key, tenantId: artifact.tenantId },
            }, { meta });
            if (driverPart === undefined) {
                throw new Error(`No driver part "${key}".`);
            }
            const driverRepo = await this.broker.call('serve.repo.resolve', { id: driverPart.repoId }, { meta });
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
    private async resolveExternals(part: Part): Promise<string[]> {
        const others = await this.broker.call('serve.part.find', {
            query: { tenantId: part.tenantId },
        }, { meta: { tenant_id: part.tenantId } });
        return others
            .filter((other) => other.id !== part.id && other.imports !== undefined)
            .map((other) => other.imports as string);
    }

    private async buildArtifact(artifact: Artifact): Promise<void> {
        const meta = { tenant_id: artifact.tenantId };

        await this.broker.call('serve.artifact.update', {
            id: artifact.id,
            status: 'running',
        }, { meta });

        try {
            const part = await this.broker.call('serve.part.resolve', {
                id: artifact.partId,
            }, { meta });
            if (part === undefined) {
                throw new Error(`No part "${artifact.partId}".`);
            }
            const repo = await this.broker.call('serve.repo.resolve', {
                id: part.repoId,
            }, { meta });
            if (repo === undefined) {
                throw new Error(`No repo "${part.repoId}".`);
            }

            const startedAt = Date.now();

            const { hash, assets, wants } = part.kind === 'kernel'
                ? await buildKernel(part, repo, artifact.ref, await this.resolveDrivers(artifact))
                : await buildPart(part, repo, artifact.ref, await this.resolveExternals(part));

            const duration = (Date.now() - startedAt) / 1000;

            const updatedArtifact = await this.broker.call('serve.artifact.update', {
                id: artifact.id,
                status: 'success',
                hash,
                assets,
                duration,
            }, { meta });

            // wants is resolved from the repo at build time (mesh.wants.json), not hand-edited --
            // refreshed on every successful build so it tracks the part's current code, same as
            // hash/assets do on the artifact.
            await this.broker.call('serve.part.update', { id: part.id, wants }, { meta });

            this.broker.emit('serve.artifact.built', {
                tenantId: artifact.tenantId,
                artifact: updatedArtifact,
                hash,
                assets,
            });

            this.broker.logger.debug(`Built artifact ${artifact.id} - ${hash} - ${duration}s`);

        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.broker?.logger.error(`Build failed for artifact ${artifact.id}`, err);
            const updatedArtifact = await this.broker.call('serve.artifact.update', {
                id: artifact.id,
                status: 'failed',
                error,
            }, { meta });

            this.broker.emit('serve.artifact.buildFailed', {
                tenantId: artifact.tenantId,
                artifact: updatedArtifact,
                error,
            });
        }
    }
}
