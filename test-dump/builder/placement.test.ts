import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ClientError, type IServiceContext } from '@flybyme/mesh';
import { buildStartContract } from '../../src/builder/contracts/artifact.contract.js';
import {
    callWithPlacement,
    getNodeMemoryMB,
    orderCandidatesForPlacement,
    type PlacementCandidate,
} from '../../src/builder/methods/placement.js';
import { builder_build_start } from '../../src/builder/tools/build_start.js';

describe('Placement: stopping the interchangeability assumption', () => {
    const originalNodeMemoryEnv = process.env['MESH_NODE_MEMORY_MB'];

    afterEach(() => {
        if (originalNodeMemoryEnv !== undefined) {
            process.env['MESH_NODE_MEMORY_MB'] = originalNodeMemoryEnv;
        } else {
            delete process.env['MESH_NODE_MEMORY_MB'];
        }
    });

    it('buildStartContract declares requirements alongside dependencies', () => {
        expect(buildStartContract.requirements).toBeDefined();
        // Measured, not guessed: 70MB peak to clone mesh-core and bundle four parts, and 512
        // fits inside surf's MemoryMax=600M so a node that accepts the work survives it.
        expect(buildStartContract.requirements?.memory).toBe(512);
        expect(buildStartContract.requirements?.preferData).toBe(true);
        expect(buildStartContract.dependencies).toBeDefined();
        expect(buildStartContract.inputSchema.shape).toHaveProperty('preferLocal');
    });

    it('declines work on a box too small to do it, rather than accepting and timing out', async () => {
        /**
         * **256MB, not surf's 981.**
         *
         * This used to simulate surf and assert it was refused, which encoded a guess as a
         * requirement: the threshold was 2048 because somebody estimated it, so the fleet's only
         * public node could not build and the test said that was correct. Measuring it (70MB peak
         * to clone mesh-core and bundle four parts) moved the threshold to 512 — and surf, at
         * 981MB, is now above it and builds. See `buildStartContract.requirements`.
         *
         * The refusal still matters and still needs a test, so this uses a box that genuinely
         * cannot do the work instead of one that was only ever assumed not to.
         */
        process.env['MESH_NODE_MEMORY_MB'] = '256';
        expect(getNodeMemoryMB()).toBe(256);

        const dummyContext = {
            call: async () => null,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        } as unknown as IServiceContext;

        let err: unknown;
        try {
            await builder_build_start.call(
                {} as any,
                { part: 'todo', version: '0.1.0' },
                dummyContext,
            );
        } catch (e) {
            err = e;
        }

        expect(err).toBeInstanceOf(ClientError);
        const clientErr = err as ClientError;
        expect(clientErr.code).toBe('insufficient_memory');
        expect(clientErr.status).toBe(507);
        expect(clientErr.message).toMatch(/declining build/i);
        expect(clientErr.message).toMatch(/256MB memory/);
        expect(clientErr.message).toMatch(/requires 512MB/);
    });

    it('accepts work on surf, which the old threshold refused', async () => {
        // The whole point of measuring: 981MB is plenty to bundle 30KB, so the one public node in
        // the fleet can build and every step of the loop can go through its API.
        process.env['MESH_NODE_MEMORY_MB'] = '981';
        expect(getNodeMemoryMB()).toBe(981);
        expect(getNodeMemoryMB()).toBeGreaterThanOrEqual(buildStartContract.requirements?.memory ?? 0);
    });

    it('accepts work on a machine meeting memory requirements', async () => {
        // Simulate a 32GB machine
        process.env['MESH_NODE_MEMORY_MB'] = '32768';
        expect(getNodeMemoryMB()).toBe(32768);

        const dummyContext = {
            call: async (tool: string) => {
                if (tool === 'part.find_one') {
                    // Fail downstream on part lookup, proving it passed the placement gate
                    return null;
                }
                return null;
            },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        } as unknown as IServiceContext;

        await expect(
            builder_build_start.call(
                {} as any,
                { part: 'todo', version: '0.1.0' },
                dummyContext,
            ),
        ).rejects.toThrow(/No part named "todo" is published/);
    });

    describe('candidate ordering and preferLocal', () => {
        const candidates: PlacementCandidate[] = [
            { nodeID: 'remote-surf', hostname: 'surf.surfdns.net' },
            { nodeID: 'local-laptop', hostname: 'laptop-node' },
        ];

        it('preserves default order when preferLocal is not specified', () => {
            const ordered = orderCandidatesForPlacement(candidates, {
                preferLocal: false,
                localNodeID: 'local-laptop',
                localHostname: 'laptop-node',
            });
            expect(ordered[0]?.nodeID).toBe('remote-surf');
            expect(ordered[1]?.nodeID).toBe('local-laptop');
        });

        it('prioritizes local node when preferLocal is set', () => {
            const ordered = orderCandidatesForPlacement(candidates, {
                preferLocal: true,
                localNodeID: 'local-laptop',
                localHostname: 'laptop-node',
            });
            expect(ordered[0]?.nodeID).toBe('local-laptop');
            expect(ordered[1]?.nodeID).toBe('remote-surf');
        });
    });

    describe('callWithPlacement execution and fallback', () => {
        it('routes to preferred local node when preferLocal is requested', async () => {
            const calls: string[] = [];

            const fakeBroker = {
                nodeID: 'laptop-node-id',
                registry: {
                    findNodesForTool: () => [
                        { nodeID: 'surf-node-id', hostname: 'surf.surfdns.net' },
                        { nodeID: 'laptop-node-id', hostname: 'laptop-host' },
                    ],
                },
                call: async (tool: string, params: unknown, opts?: { nodeID?: string }) => {
                    calls.push(opts?.nodeID ?? 'unknown');
                    return { success: true };
                },
            };

            const res = await callWithPlacement(fakeBroker, 'builder.build_start', {
                part: 'todo',
                version: '0.1.0',
                preferLocal: true,
            });

            expect(res).toEqual({ success: true });
            expect(calls).toEqual(['laptop-node-id']);
        });

        it('falls back to next capable node when first node declines due to insufficient memory', async () => {
            const calls: string[] = [];

            const fakeBroker = {
                nodeID: 'cli-node-id',
                registry: {
                    findNodesForTool: () => [
                        { nodeID: 'surf-node-id', hostname: 'surf.surfdns.net' },
                        { nodeID: 'laptop-node-id', hostname: 'laptop-host' },
                    ],
                },
                call: async (tool: string, params: unknown, opts?: { nodeID?: string }) => {
                    calls.push(opts?.nodeID ?? 'unknown');
                    if (opts?.nodeID === 'surf-node-id') {
                        throw new ClientError(
                            'Node "surf.surfdns.net" has 981MB memory, declining build (requires 512MB)',
                            'insufficient_memory',
                            507,
                        );
                    }
                    return { state: 'succeeded', artifactDigest: 'sha256:abc' };
                },
            };

            const res = await callWithPlacement<{ state: string }>(
                fakeBroker,
                'builder.build_start',
                { part: 'todo', version: '0.1.0' },
            );

            expect(calls).toEqual(['surf-node-id', 'laptop-node-id']);
            expect(res.state).toBe('succeeded');
        });

        it('does not catch or fall back on business errors (e.g. part_not_found)', async () => {
            const calls: string[] = [];

            const fakeBroker = {
                registry: {
                    findNodesForTool: () => [
                        { nodeID: 'node-1', hostname: 'host-1' },
                        { nodeID: 'node-2', hostname: 'host-2' },
                    ],
                },
                call: async (tool: string, params: unknown, opts?: { nodeID?: string }) => {
                    calls.push(opts?.nodeID ?? 'unknown');
                    throw new ClientError('No part named "missing" is published.', 'part_not_found', 404);
                },
            };

            await expect(
                callWithPlacement(fakeBroker, 'builder.build_start', {
                    part: 'missing',
                    version: '0.1.0',
                }),
            ).rejects.toThrow(/No part named "missing" is published/);

            // Did not retry on node-2 because 404 is a real refusal, not a capacity problem
            expect(calls).toEqual(['node-1']);
        });
    });
});
