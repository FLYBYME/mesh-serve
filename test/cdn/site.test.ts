/**
 * The site record — what `mesh.json` becomes once it stops being a file.
 *
 * Everything here is about a shape being *unrepresentable* rather than merely discouraged. This
 * collection decides what is reachable from outside the mesh, so a record that forgets to say who may
 * call something must not parse. paas is the argument: its contracts were reachable as though public,
 * and that was not caught by anything because nothing could catch it.
 */

import { describe, expect, it } from 'vitest';

import {
    ExposedContractSchema, MeshDependencySchema, SiteSchema,
} from '../../src/cdn/schema/site.js';

const site = (over: Record<string, unknown> = {}) => ({
    host: 'console.surfdns.net',
    application: 'surfdns-console',
    tenantId: 'org-1',
    api: 'https://console.surfdns.net/api',
    // What it serves is a release, not a composition of its own. Changing this one field is the
    // deploy, and pointing two sites at it makes them provably identical.
    releaseHash: 'sha256:abc123',
    mesh: [{
        package: '@flybyme/surfdns-domains',
        version: '^2.1',
        contracts: [{ key: 'domains.zone_create', auth: 'user' }],
    }],
    theme: { '--surface': '#161b22' },
    policy: { 'window-manager/mode': 'tiled' },
    ...over,
});

describe('a gate is not optional', () => {
    it('takes an auth level', () => {
        expect(ExposedContractSchema.safeParse({ key: 'domains.zone_find', auth: 'public' }).success)
            .toBe(true);
    });

    it('takes a named permission instead', () => {
        expect(ExposedContractSchema.safeParse({ key: 'domains.zone_delete', permission: 'domains.admin' }).success)
            .toBe(true);
    });

    it('refuses an entry with no gate at all', () => {
        // The failure this prevents is a contract quietly reachable by anyone, which is the specific
        // way 100k lines of paas went wrong.
        expect(ExposedContractSchema.safeParse({ key: 'domains.zone_delete' }).success).toBe(false);
    });

    it('refuses an entry carrying both, rather than silently preferring one', () => {
        // This is what `.strict()` buys. Without it zod strips the unknown key and the record parses
        // as whichever branch matched first — so an author who wrote both would get one of them,
        // chosen by declaration order, with nothing said.
        const both = { key: 'domains.zone_delete', auth: 'user', permission: 'domains.admin' };

        expect(ExposedContractSchema.safeParse(both).success).toBe(false);
    });
});

describe('a dependency that takes nothing is refused', () => {
    it('needs at least one contract', () => {
        const empty = { package: '@flybyme/surfdns-domains', version: '^2.1', contracts: [] };

        // A package named with nothing taken from it does nothing, which is far more likely to be a
        // half-finished edit than an intention.
        expect(MeshDependencySchema.safeParse(empty).success).toBe(false);
    });
});

describe('what runs is separate from where it runs', () => {
    it('holds no composition of its own', () => {
        // It used to hold a kernel range, part ranges, and the resolution of both. While it did,
        // two sites naming `^1.4` resolved independently and at different times — so "staging runs
        // the same code as production" was a claim nobody could check.
        const fields = Object.keys(SiteSchema.shape);
        expect(fields).not.toContain('kernel');
        expect(fields).not.toContain('parts');
        expect(fields).not.toContain('resolution');
    });

    it('names a release instead, and that one field is the deploy', () => {
        expect(SiteSchema.parse(site()).releaseHash).toBe('sha256:abc123');
    });

    it('parses a site that has never been deployed', () => {
        // A hostname reserved before its first deploy. Ordinary, not an error.
        const { releaseHash: _, ...reserved } = site();
        const parsed = SiteSchema.safeParse(reserved);

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.releaseHash).toBeUndefined();
    });

    it('keeps what it exposes, because that is the deployment\'s decision', () => {
        // A release says what its parts *call*; the site says what is reachable and at what gate.
        // One site may expose a contract as public while another requires `user`, on one release.
        expect(SiteSchema.parse(site()).mesh[0]?.contracts).toHaveLength(1);
    });
});

describe('what a person and a crawler read', () => {
    it('lives on the site, because two sites on one release are different identities', () => {
        const parsed = SiteSchema.parse(site({
            title: 'surfdns console', description: 'Operate your zones.',
        }));

        expect(parsed.title).toBe('surfdns console');
        expect(parsed.description).toBe('Operate your zones.');
    });

    it('is indexable unless a site says otherwise', () => {
        // A staging site on the same release as production must be able to say no.
        expect(SiteSchema.parse(site()).indexable).toBe(true);
        expect(SiteSchema.parse(site({ indexable: false })).indexable).toBe(false);
    });
});

describe('a site is a hostname', () => {
    it('carries no environment, because production and local are two sites', () => {
        expect(Object.keys(SiteSchema.shape)).not.toContain('environment');
        expect(Object.keys(SiteSchema.shape)).not.toContain('environments');
    });

    it('refuses a site with no owner', () => {
        // The origin is the isolation boundary, and a serving-layer invariant checks it on every
        // request — so the answer has to be on the record.
        expect(SiteSchema.safeParse(site({ tenantId: undefined })).success).toBe(false);
    });
});
