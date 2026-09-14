import type { IServiceBroker } from '@flybyme/mesh';
import { Database, ServiceModule } from '@flybyme/mesh';

import { repoCrud, type Repo } from './contracts/repo.contract.js';
import { partCrud, type Part } from './contracts/part.contract.js';
import { compositionCrud } from './contracts/composition.contract.js';
import { artifactCrud, artifactGetArtifactContract, artifactGetAssetContract, artifactRequestBuildContract, type Artifact } from './contracts/artifact.contract.js';
import { releaseCrud, releaseGetReleaseContract } from './contracts/release.contract.js';

import { getArtifact } from './tools/getArtifact.js';
import { getAsset } from './tools/getAsset.js';
import { getRelease } from './tools/getRelease.js';
import { requestBuild } from './tools/requestBuild.js';
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
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        this.watchInterval = setInterval(() => {
            this.watchRelease();
        }, 1000 * 60);// 60 seconds
    }

    public async onStop(): Promise<void> {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
        }
    }

    private async watchRelease(): Promise<void> {
        const pending = await this.broker.call('serve.artifact.find', { query: { status: 'pending' } });
        for (const artifact of pending) {
            await this.buildArtifact(artifact);
        }
    }

    private async resolveDrivers(artifact: Artifact): Promise<{ part: Part; repo: Repo }[]> {
        const resolved: { part: Part; repo: Repo }[] = [];
        for (const key of artifact.drivers ?? []) {
            const driverPart = await this.broker.call('serve.part.find_one', {
                query: { key, tenantId: artifact.tenantId },
            });
            if (driverPart === undefined) {
                throw new Error(`No driver part "${key}".`);
            }
            const driverRepo = await this.broker.call('serve.repo.resolve', { id: driverPart.repoId });
            if (driverRepo === undefined) {
                throw new Error(`No repo "${driverPart.repoId}" for driver "${key}".`);
            }
            resolved.push({ part: driverPart, repo: driverRepo });
        }
        return resolved;
    }

    private async buildArtifact(artifact: Artifact): Promise<void> {

        await this.broker.call('serve.artifact.update', {
            id: artifact.id,
            status: 'running',
        });

        try {
            const part = await this.broker.call('serve.part.resolve', {
                id: artifact.partId,
            });
            if (part === undefined) {
                throw new Error(`No part "${artifact.partId}".`);
            }
            const repo = await this.broker.call('serve.repo.resolve', {
                id: part.repoId,
            });
            if (repo === undefined) {
                throw new Error(`No repo "${part.repoId}".`);
            }

            const startedAt = Date.now();

            const { hash, assets } = part.kind === 'kernel'
                ? await buildKernel(part, repo, artifact.ref, await this.resolveDrivers(artifact))
                : await buildPart(part, repo, artifact.ref);

            const duration = (Date.now() - startedAt) / 1000;

            const updatedArtifact = await this.broker.call('serve.artifact.update', {
                id: artifact.id,
                status: 'success',
                hash,
                assets,
                duration,
            });

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
            });

            this.broker.emit('serve.artifact.buildFailed', {
                tenantId: artifact.tenantId,
                artifact: updatedArtifact,
                error,
            });
        }
    }
}
