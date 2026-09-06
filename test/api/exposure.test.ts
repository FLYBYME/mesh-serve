/**
 * D4 — The Exposure Hash and Shape Hash.
 *
 * Success criteria:
 * 1. Test where client generated against one exposure meets API serving another, and the failure
 *    names the difference (contract and what changed; not a 404 or schema error three calls in).
 * 2. Test where reordering declarations does not change the hash.
 * 3. Test where changing a gate changes the gate hash and does NOT change the shape hash.
 */

import { defineContract, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import {
    assertExposureMatch,
    diffExposure,
    emitClient,
    ExposureMismatchError,
    verifyClientExposure,
} from '../../src/api/methods/client.js';
import { routeTable, type ContractLookup } from '../../src/api/methods/routes.js';
import {
    describeExposure,
    hashShape,
    type CallShape,
} from '../../src/api/schema/descriptor.js';
import { canonical, digestOf } from '../../src/builder/methods/content.js';
import type { MeshDependency } from '../../src/cdn/schema/site.js';

const hash = (value: unknown): string => digestOf(canonical(value));

const zoneFindContract = defineContract({
    domain: 'domains',
    action: 'zone_find',
    description: 'Find domain zones',
    inputSchema: z.object({ query: z.string().optional() }),
    outputSchema: z.object({ zones: z.array(z.string()) }),
    rest: { method: 'GET', path: '/zones' },
    visibility: 'public',
    print: () => '',
});

const zoneDeleteContract = defineContract({
    domain: 'domains',
    action: 'zone_delete',
    description: 'Delete domain zone',
    inputSchema: z.object({ zoneId: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    rest: { method: 'DELETE', path: '/zones/:zoneId' },
    visibility: 'public',
    print: () => '',
});

const zoneFindV2Contract = defineContract({
    domain: 'domains',
    action: 'zone_find',
    description: 'Find domain zones v2',
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().optional() }),
    outputSchema: z.object({ zones: z.array(z.string()) }),
    rest: { method: 'GET', path: '/zones' },
    visibility: 'public',
    print: () => '',
});

const zoneFindMethodPost = defineContract({
    domain: 'domains',
    action: 'zone_find',
    description: 'Find domain zones via POST',
    inputSchema: z.object({ query: z.string().optional() }),
    outputSchema: z.object({ zones: z.array(z.string()) }),
    rest: { method: 'POST', path: '/zones' },
    visibility: 'public',
    print: () => '',
});

const zoneFindPathV2 = defineContract({
    domain: 'domains',
    action: 'zone_find',
    description: 'Find domain zones on /v2/zones',
    inputSchema: z.object({ query: z.string().optional() }),
    outputSchema: z.object({ zones: z.array(z.string()) }),
    rest: { method: 'GET', path: '/v2/zones' },
    visibility: 'public',
    print: () => '',
});

const zoneFindOutputChanged = defineContract({
    domain: 'domains',
    action: 'zone_find',
    description: 'Find domain zones with extra fields',
    inputSchema: z.object({ query: z.string().optional() }),
    outputSchema: z.object({ zones: z.array(z.string()), total: z.number() }),
    rest: { method: 'GET', path: '/zones' },
    visibility: 'public',
    print: () => '',
});

describe('shape hash vs gate hash invariants', () => {
    it('changing a gate changes the gate hash and does NOT change the shape hash', () => {
        const publicDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const userDesc = describeExposure([
            { contract: zoneFindContract, auth: 'user' },
        ], { application: 'surfdns' });

        const adminDesc = describeExposure([
            { contract: zoneFindContract, auth: 'admin' },
        ], { application: 'surfdns' });

        const permDesc = describeExposure([
            { contract: zoneFindContract, permission: 'domains.read' },
        ], { application: 'surfdns' });

        // Shape hash is identical across all gates
        expect(publicDesc.shapeHash).toBe(userDesc.shapeHash);
        expect(publicDesc.shapeHash).toBe(adminDesc.shapeHash);
        expect(publicDesc.shapeHash).toBe(permDesc.shapeHash);

        // Gate hash (exposure) changes with each gate
        expect(publicDesc.exposure).not.toBe(userDesc.exposure);
        expect(userDesc.exposure).not.toBe(adminDesc.exposure);
        expect(adminDesc.exposure).not.toBe(permDesc.exposure);
    });

    it('reordering declarations does not change shape hash or gate hash', () => {
        const orderA = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
            { contract: zoneDeleteContract, auth: 'admin' },
        ], { application: 'surfdns' });

        const orderB = describeExposure([
            { contract: zoneDeleteContract, auth: 'admin' },
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        expect(orderA.shapeHash).toBe(orderB.shapeHash);
        expect(orderA.exposure).toBe(orderB.exposure);
    });

    it('reordering errors in call shape does not change the shape hash', () => {
        const call1: CallShape = {
            key: 'test.action',
            method: 'GET',
            path: '/test',
            input: { type: 'object' },
            output: { type: 'object' },
            errors: ['NOT_FOUND', 'UNAUTHORIZED', 'BAD_REQUEST'],
        };

        const call2: CallShape = {
            key: 'test.action',
            method: 'GET',
            path: '/test',
            input: { type: 'object' },
            output: { type: 'object' },
            errors: ['BAD_REQUEST', 'NOT_FOUND', 'UNAUTHORIZED'],
        };

        expect(hashShape([call1])).toBe(hashShape([call2]));
    });

    it('changing input schema changes shape hash', () => {
        const desc1 = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const desc2 = describeExposure([
            { contract: zoneFindV2Contract, auth: 'public' },
        ], { application: 'surfdns' });

        expect(desc1.shapeHash).not.toBe(desc2.shapeHash);
    });

    it('changing output schema changes shape hash', () => {
        const desc1 = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const desc2 = describeExposure([
            { contract: zoneFindOutputChanged, auth: 'public' },
        ], { application: 'surfdns' });

        expect(desc1.shapeHash).not.toBe(desc2.shapeHash);
    });

    it('changing method or path changes shape hash', () => {
        const descBase = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const descMethod = describeExposure([
            { contract: zoneFindMethodPost, auth: 'public' },
        ], { application: 'surfdns' });

        const descPath = describeExposure([
            { contract: zoneFindPathV2, auth: 'public' },
        ], { application: 'surfdns' });

        expect(descBase.shapeHash).not.toBe(descMethod.shapeHash);
        expect(descBase.shapeHash).not.toBe(descPath.shapeHash);
    });

    it('routeTable produces matching shape hash and gate hash', () => {
        const lookup: ContractLookup = (key) => {
            if (key === 'domains.zone_find') return zoneFindContract;
            if (key === 'domains.zone_delete') return zoneDeleteContract;
            return undefined;
        };

        const meshPub: readonly MeshDependency[] = [{
            package: '@flybyme/surfdns-domains',
            version: '1.0.0',
            contracts: [{ key: 'domains.zone_find', auth: 'public' }],
            events: [],
        }];

        const meshUser: readonly MeshDependency[] = [{
            package: '@flybyme/surfdns-domains',
            version: '1.0.0',
            contracts: [{ key: 'domains.zone_find', auth: 'user' }],
            events: [],
        }];

        const tablePub = routeTable(meshPub, lookup, hash);
        const tableUser = routeTable(meshUser, lookup, hash);

        // Shape hashes are equal across gates
        expect(tablePub.shapeHash).toBe(tableUser.shapeHash);
        // Gate hashes differ
        expect(tablePub.exposure).not.toBe(tableUser.exposure);
    });
});

describe('client meets API exposure verification', () => {
    it('succeeds when client and API exposures match', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
            { contract: zoneDeleteContract, auth: 'admin' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
            { contract: zoneDeleteContract, auth: 'admin' },
        ], { application: 'surfdns' });

        expect(diffExposure(clientDesc, apiDesc)).toEqual([]);
        expect(() => {
            assertExposureMatch(clientDesc, apiDesc);
        }).not.toThrow();
        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).not.toThrow();
    });

    it('fails naming missing contract when API does not expose it', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
            { contract: zoneDeleteContract, auth: 'admin' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('missing');
        expect(diffs[0]?.contract).toBe('domains.zone_delete');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_delete" is not exposed by the API.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrowError(ExposureMismatchError);

        try {
            verifyClientExposure(clientDesc, apiDesc);
        } catch (err) {
            expect(err).toBeInstanceOf(ExposureMismatchError);
            if (err instanceof ExposureMismatchError) {
                expect(err.contract).toBe('domains.zone_delete');
                expect(err.difference).toBe('Contract "domains.zone_delete" is not exposed by the API.');
                expect(err.message).toBe('Exposure mismatch: Contract "domains.zone_delete" is not exposed by the API.');
            }
        }
    });

    it('fails naming contract and what changed when input schema differs', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindV2Contract, auth: 'public' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('input');
        expect(diffs[0]?.contract).toBe('domains.zone_find');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_find" input schema changed.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_find" input schema changed.',
        );
    });

    it('fails naming contract and what changed when output schema differs', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindOutputChanged, auth: 'public' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('output');
        expect(diffs[0]?.contract).toBe('domains.zone_find');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_find" output schema changed.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_find" output schema changed.',
        );
    });

    it('fails naming contract and what changed when HTTP method differs', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindMethodPost, auth: 'public' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('method');
        expect(diffs[0]?.contract).toBe('domains.zone_find');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_find" method changed from GET to POST.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_find" method changed from GET to POST.',
        );
    });

    it('fails naming contract and what changed when route path differs', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindPathV2, auth: 'public' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('path');
        expect(diffs[0]?.contract).toBe('domains.zone_find');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_find" path changed from /zones to /v2/zones.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_find" path changed from /zones to /v2/zones.',
        );
    });

    it('fails naming contract and what changed when gate differs', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindContract, auth: 'user' },
        ], { application: 'surfdns' });

        const diffs = diffExposure(clientDesc, apiDesc);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.kind).toBe('gate');
        expect(diffs[0]?.contract).toBe('domains.zone_find');
        expect(diffs[0]?.message).toBe('Contract "domains.zone_find" gate changed from public to user.');

        expect(() => {
            verifyClientExposure(clientDesc, apiDesc);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_find" gate changed from public to user.',
        );
    });

    it('allows ignoring gate differences when checkGates is false', () => {
        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const apiDesc = describeExposure([
            { contract: zoneFindContract, auth: 'user' },
        ], { application: 'surfdns' });

        // With checkGates: false, shapes match so diff is empty
        expect(diffExposure(clientDesc, apiDesc, { checkGates: false })).toEqual([]);
        expect(() => {
            verifyClientExposure(clientDesc, apiDesc, { checkGates: false });
        }).not.toThrow();
    });

    it('verifies client descriptor directly against RouteTable', () => {
        const lookup: ContractLookup = (key) =>
            key === 'domains.zone_find' ? zoneFindContract : undefined;

        const meshMatching: readonly MeshDependency[] = [{
            package: '@flybyme/surfdns-domains',
            version: '1.0.0',
            contracts: [{ key: 'domains.zone_find', auth: 'public' }],
            events: [],
        }];

        const table = routeTable(meshMatching, lookup, hash);

        const clientDesc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        expect(() => {
            verifyClientExposure(clientDesc, table);
        }).not.toThrow();

        const clientDescExtra = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
            { contract: zoneDeleteContract, auth: 'admin' },
        ], { application: 'surfdns' });

        expect(() => {
            verifyClientExposure(clientDescExtra, table);
        }).toThrow(
            'Exposure mismatch: Contract "domains.zone_delete" is not exposed by the API.',
        );
    });
});

describe('client emission', () => {
    it('emits both exposure and shapeHash in the client and its header', () => {
        const desc = describeExposure([
            { contract: zoneFindContract, auth: 'public' },
        ], { application: 'surfdns' });

        const code = emitClient(desc);

        expect(code).toContain(`Exposure: ${desc.exposure}`);
        expect(code).toContain(`ShapeHash: ${desc.shapeHash}`);
        expect(code).toContain(`exposure: "${desc.exposure}"`);
        expect(code).toContain(`shapeHash: "${desc.shapeHash}"`);
    });
});
