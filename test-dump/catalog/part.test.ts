/**
 * The catalog's records.
 *
 * A `partVersion` row is what a site resolves to, so a shape that parses when it should not is a
 * shape that can change what runs on somebody's hostname.
 */

import { describe, expect, it } from 'vitest';

import {
    CapabilitiesSchema, PartSchema, PartVersionSchema, VersionStateSchema,
} from '../../src/catalog/schema/part.js';

const version = (over: Record<string, unknown> = {}) => ({
    partName: 'auth',
    version: '0.1.0',
    commit: 'a'.repeat(40),
    entry: 'src/index.ts',
    kernel: '^0.2',
    requires: ['identity.whoami'],
    capabilities: { needs: ['credentials', 'state', 'log'], provides: ['mesh-web/auth'] },
    state: 'declared',
    publishedAt: new Date(0),
    ...over,
});

describe('a part', () => {
    it('is named, not identified', () => {
        // `id` belongs to the framework — `defineCrud` mints it and refuses a schema declaring one.
        // So the domain key is an ordinary field, and uniqueness is an index plus a check.
        expect('id' in PartSchema.shape).toBe(false);
        expect(PartSchema.safeParse({
            name: 'auth', kind: 'extension', repository: 'https://github.com/FLYBYME/mesh-auth',
            publisher: 'org-1',
        }).success).toBe(true);
    });

    it('is one of three kinds, in one collection', () => {
        for (const kind of ['kernel', 'application', 'extension']) {
            expect(PartSchema.safeParse({
                name: 'x', kind, repository: 'r', publisher: 'p',
            }).success).toBe(true);
        }
        expect(PartSchema.safeParse({
            name: 'x', kind: 'theme', repository: 'r', publisher: 'p',
        }).success).toBe(false);
    });

    it('always has a publisher, because publishing changes what runs elsewhere', () => {
        expect(PartSchema.safeParse({ name: 'x', kind: 'kernel', repository: 'r' }).success).toBe(false);
    });
});

describe('a version', () => {
    it('records the commit it is, as forty hex characters', () => {
        expect(PartVersionSchema.safeParse(version()).success).toBe(true);
        expect(PartVersionSchema.safeParse(version({ commit: 'HEAD' })).success).toBe(false);
        expect(PartVersionSchema.safeParse(version({ commit: 'a'.repeat(39) })).success).toBe(false);
    });

    it('cannot be published without one', () => {
        // A declared semver makes ranges resolvable; the commit makes them honest. It is also what a
        // rebuild needs, and a rebuild is the only durability story there is.
        const { commit: _, ...without } = version();
        expect(PartVersionSchema.safeParse(without).success).toBe(false);
    });

    it('has no kernel when it is the kernel', () => {
        expect(PartVersionSchema.safeParse(version({ kernel: undefined })).success).toBe(true);
    });

    it('starts declared, before anything is built', () => {
        // The row exists and is buildable — that is the point of it. A version is something you can
        // ask for before anyone has produced the bytes.
        const parsed = PartVersionSchema.parse(version());
        expect(parsed.state).toBe('declared');
        expect(parsed.artifactDigest).toBeUndefined();
    });

    it('can be gone, which is not an error', () => {
        // An edge's disk is a cache and a pod's storage is deleted on restart, so "built once, held
        // by nobody" is an ordinary state and the signal to rebuild.
        expect(VersionStateSchema.options).toEqual(['declared', 'built', 'gone']);
        expect(PartVersionSchema.safeParse(version({ state: 'gone' })).success).toBe(true);
    });

    it('defaults to requiring and providing nothing', () => {
        const parsed = PartVersionSchema.parse(version({ requires: undefined, capabilities: {} }));
        expect(parsed.requires).toEqual([]);
        expect(parsed.capabilities).toEqual({ needs: [], provides: [] });
    });
});

describe('capabilities are a requirement, never a permission', () => {
    it('says what a part needs, with nowhere to say what it is allowed', () => {
        // A part that could state its own permission would make installing one a privilege
        // escalation with nobody in the loop. There is no `auth` and no `allow` here on purpose.
        const shape = Object.keys(CapabilitiesSchema.shape);
        expect(shape).toEqual(['needs', 'provides']);
    });
});
