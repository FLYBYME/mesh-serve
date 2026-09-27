import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../../../src/catalog/contracts/artifact.contract.js';
import type { Part } from '../../../src/catalog/contracts/part.contract.js';
import type { Repo } from '../../../src/catalog/contracts/repo.contract.js';
import { createMockContext } from '../helpers/mockContext.js';
import { requestBuild } from '../../../src/catalog/tools/requestBuild.js';
import { buildArtifact } from '../../../src/catalog/methods/buildArtifact.js';
import { buildService } from '../../../src/catalog/methods/build.js';

vi.mock('../../../src/catalog/methods/build.js', () => ({
    buildService: vi.fn(),
    buildKernel: vi.fn(),
    buildPart: vi.fn(),
}));

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
    return {
        id: 'art-1',
        tenantId: 'tenant-1',
        partId: 'part-1',
        ref: 'master',
        status: 'pending',
        createdAt: new Date('2026-09-26T20:00:00Z'),
        updatedAt: new Date('2026-09-26T20:00:00Z'),
        ...overrides,
    };
}

function makePart(overrides: Partial<Part> = {}): Part {
    return {
        id: 'part-1',
        tenantId: 'tenant-1',
        repoId: 'repo-1',
        key: 'org/svc',
        kind: 'service',
        path: '.',
        entryPoint: 'src/index.ts',
        wants: [],
        desired: 'stopped',
        createdAt: new Date('2026-09-26T19:00:00Z'),
        updatedAt: new Date('2026-09-26T19:00:00Z'),
        ...overrides,
    };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
    return {
        id: 'repo-1',
        tenantId: 'tenant-1',
        name: 'test-repo',
        url: '/tmp/repo.git',
        defaultBranch: 'main',
        createdAt: new Date('2026-09-26T18:00:00Z'),
        updatedAt: new Date('2026-09-26T18:00:00Z'),
        ...overrides,
    };
}

describe('pin on success', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('serve.artifact.requestBuild', () => {
        it('remembers pinOnSuccess: true when pin: true is provided', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.part.resolve': async () => makePart(),
                    'serve.artifact.create': async (params) => ({ id: 'art-1', ...params }),
                },
            });

            await requestBuild({ partId: 'part-1', ref: 'master', pin: true }, ctx);

            const createCall = calls.find((c) => c.action === 'serve.artifact.create');
            expect(createCall).toBeDefined();
            expect(createCall?.params.pinOnSuccess).toBe(true);
        });

        it('remembers pinOnSuccess: false when pin: false is provided', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.part.resolve': async () => makePart(),
                    'serve.artifact.create': async (params) => ({ id: 'art-1', ...params }),
                },
            });

            await requestBuild({ partId: 'part-1', ref: 'master', pin: false }, ctx);

            const createCall = calls.find((c) => c.action === 'serve.artifact.create');
            expect(createCall).toBeDefined();
            expect(createCall?.params.pinOnSuccess).toBe(false);
        });
    });

    describe('buildArtifact auto-pinning', () => {
        it('success with pin -> part pinned', async () => {
            vi.mocked(buildService).mockResolvedValue({
                hash: 'hash-success',
                assets: [{ url: 'main.js', name: 'main.js' }],
                wants: ['some.contract'],
                commit: 'c1234',
            });

            let currentPart = makePart();
            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.artifact.update': async (params) => makeArtifact({ ...params }),
                    'serve.part.resolve': async () => currentPart,
                    'serve.repo.resolve': async () => makeRepo(),
                    'serve.part.update': async (params) => {
                        currentPart = { ...currentPart, ...params };
                        return currentPart;
                    },
                },
            });

            const artifact = makeArtifact({ pinOnSuccess: true });
            await buildArtifact(ctx.broker, artifact);

            const pinCall = calls.find(
                (c) => c.action === 'serve.part.update' && c.params?.artifactId !== undefined,
            );
            expect(pinCall).toBeDefined();
            expect(pinCall?.params).toEqual({ id: 'part-1', artifactId: 'art-1' });
            expect(currentPart.artifactId).toBe('art-1');
        });

        it('success without pin -> part unchanged', async () => {
            vi.mocked(buildService).mockResolvedValue({
                hash: 'hash-no-pin',
                assets: [{ url: 'main.js', name: 'main.js' }],
                wants: [],
                commit: 'c1234',
            });

            const currentPart = makePart({ artifactId: undefined });
            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.artifact.update': async (params) => makeArtifact({ ...params }),
                    'serve.part.resolve': async () => currentPart,
                    'serve.repo.resolve': async () => makeRepo(),
                    'serve.part.update': async (params) => params,
                },
            });

            const artifact = makeArtifact({ pinOnSuccess: false });
            await buildArtifact(ctx.broker, artifact);

            const pinCall = calls.find(
                (c) => c.action === 'serve.part.update' && c.params?.artifactId !== undefined,
            );
            expect(pinCall).toBeUndefined();
        });

        it('failure with pin -> unchanged', async () => {
            vi.mocked(buildService).mockRejectedValue(new Error('build error: tsc exploded'));

            const currentPart = makePart({ artifactId: undefined });
            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.artifact.update': async (params) => makeArtifact({ ...params }),
                    'serve.part.resolve': async () => currentPart,
                    'serve.repo.resolve': async () => makeRepo(),
                    'serve.part.update': async (params) => params,
                },
            });

            const artifact = makeArtifact({ pinOnSuccess: true });
            await buildArtifact(ctx.broker, artifact);

            const failedUpdate = calls.find(
                (c) => c.action === 'serve.artifact.update' && c.params?.status === 'failed',
            );
            expect(failedUpdate).toBeDefined();

            const pinCall = calls.find(
                (c) => c.action === 'serve.part.update' && c.params?.artifactId !== undefined,
            );
            expect(pinCall).toBeUndefined();
        });

        it('a newer pin already present -> unchanged', async () => {
            vi.mocked(buildService).mockResolvedValue({
                hash: 'hash-built',
                assets: [{ url: 'main.js', name: 'main.js' }],
                wants: [],
                commit: 'c1234',
            });

            // The part is already pinned to art-newer, which was created at 21:00 (after this build's artifact created at 20:00).
            const artNewer = makeArtifact({
                id: 'art-newer',
                status: 'success',
                createdAt: new Date('2026-09-26T21:00:00Z'),
            });
            const currentPart = makePart({ artifactId: 'art-newer' });

            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.artifact.update': async (params) => makeArtifact({
                        ...params,
                        createdAt: new Date('2026-09-26T20:00:00Z'),
                    }),
                    'serve.part.resolve': async () => currentPart,
                    'serve.repo.resolve': async () => makeRepo(),
                    'serve.artifact.resolve': async ({ id }) => (id === 'art-newer' ? artNewer : undefined),
                    'serve.part.update': async (params) => params,
                },
            });

            const artifact = makeArtifact({
                id: 'art-older',
                createdAt: new Date('2026-09-26T20:00:00Z'),
                pinOnSuccess: true,
            });
            await buildArtifact(ctx.broker, artifact);

            // wants is updated, but artifactId must not be moved backwards to art-older
            const pinCall = calls.find(
                (c) => c.action === 'serve.part.update' && c.params?.artifactId !== undefined,
            );
            expect(pinCall).toBeUndefined();
        });

        it('pins forward when existing pin is older than this artifact', async () => {
            vi.mocked(buildService).mockResolvedValue({
                hash: 'hash-newer-built',
                assets: [{ url: 'main.js', name: 'main.js' }],
                wants: [],
                commit: 'c1234',
            });

            // The part is pinned to art-older created at 19:00. This artifact was created at 20:00.
            const artOlder = makeArtifact({
                id: 'art-older',
                status: 'success',
                createdAt: new Date('2026-09-26T19:00:00Z'),
            });
            let currentPart = makePart({ artifactId: 'art-older' });

            const { ctx, calls } = createMockContext({
                handlers: {
                    'serve.artifact.update': async (params) => makeArtifact({
                        ...params,
                        createdAt: new Date('2026-09-26T20:00:00Z'),
                    }),
                    'serve.part.resolve': async () => currentPart,
                    'serve.repo.resolve': async () => makeRepo(),
                    'serve.artifact.resolve': async ({ id }) => (id === 'art-older' ? artOlder : undefined),
                    'serve.part.update': async (params) => {
                        currentPart = { ...currentPart, ...params };
                        return currentPart;
                    },
                },
            });

            const artifact = makeArtifact({
                id: 'art-newer',
                createdAt: new Date('2026-09-26T20:00:00Z'),
                pinOnSuccess: true,
            });
            await buildArtifact(ctx.broker, artifact);

            const pinCall = calls.find(
                (c) => c.action === 'serve.part.update' && c.params?.artifactId !== undefined,
            );
            expect(pinCall).toBeDefined();
            expect(pinCall?.params).toEqual({ id: 'part-1', artifactId: 'art-newer' });
            expect(currentPart.artifactId).toBe('art-newer');
        });
    });
});
