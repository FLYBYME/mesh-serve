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
    kernel: '^1.4',
    parts: [
        { kind: 'extension', id: 'chrome', version: '^1.0' },
        { kind: 'application', id: 'process-monitor', version: '*' },
    ],
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

describe('desired and resolved are different fields with different writers', () => {
    it('parses a site that has never been composed', () => {
        const parsed = SiteSchema.safeParse(site());

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.resolution).toBeUndefined();
    });

    it('keeps the requirement and the resolved digest side by side', () => {
        const parsed = SiteSchema.parse(site({
            resolution: {
                kernel: { version: '1.4.7', digest: 'sha256:aaa' },
                parts: { chrome: { version: '1.0.3', digest: 'sha256:bbb' } },
                exposure: 'sha256:ccc',
                page: 'sha256:ddd',
                resolvedAt: new Date(0),
            },
        }));

        // `^1.0` is what someone asked for; `1.0.3` is what is running. Collapsing them would make
        // "what is this site actually running" unanswerable, which is the question the whole
        // declared/desired/observed split exists to keep answerable.
        expect(parsed.parts[0]?.version).toBe('^1.0');
        expect(parsed.resolution?.parts['chrome']?.version).toBe('1.0.3');
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
