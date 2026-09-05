/**
 * `mesh.json` in a part repository.
 *
 * This file is written by hand, by someone who is not watching the builder's logs, so half of what
 * is tested here is the *message*. The other half is the rule that keeps the whole exposure model
 * honest: **a part declares a requirement and can never declare a grant.**
 */

import { describe, expect, it } from 'vitest';

import {
    DescriptorError, parseDescriptor, requirementsOf,
} from '../../src/builder/schema/descriptor.js';

const descriptor = (over: Record<string, unknown> = {}): string => JSON.stringify({
    kernel: '^1.4',
    parts: [
        { kind: 'extension', id: 'chrome', version: '1.0.0', entry: 'src/chrome.ts' },
        {
            kind: 'application',
            id: 'process-monitor',
            version: '1.0.0',
            entry: 'src/app.ts',
            mesh: [{
                package: '@flybyme/surfdns-domains',
                version: '^2.1',
                contracts: ['domains.zone_find', 'domains.zone_create'],
            }],
        },
    ],
    ...over,
});

describe('a repository builds parts', () => {
    it('reads them', () => {
        const parsed = parseDescriptor(descriptor());

        expect(parsed.parts.map((p) => p.id)).toEqual(['chrome', 'process-monitor']);
        expect(parsed.kernel).toBe('^1.4');
    });

    it('defaults a part that calls nothing to requiring nothing', () => {
        const parsed = parseDescriptor(descriptor());
        expect(parsed.parts[0]?.mesh).toEqual([]);
    });

    it('has no kernel when the repository is the kernel', () => {
        const parsed = parseDescriptor(JSON.stringify({
            parts: [{ kind: 'kernel', id: 'mesh-web', version: '1.4.0', entry: 'src/index.ts' }],
        }));
        expect(parsed.kernel).toBeUndefined();
    });
});

describe('a part cannot choose its own gate', () => {
    it('refuses a contract entry that carries an auth level', () => {
        // The whole exposure model rests on this. If a repository could declare
        // `domains.zone_delete: public`, then installing a part would be a privilege escalation with
        // nobody in the loop.
        const withGate = JSON.stringify({
            parts: [{
                kind: 'application', id: 'a', version: '1.0.0', entry: 'src/a.ts',
                mesh: [{
                    package: 'p', version: '1', contracts: [{ key: 'domains.zone_delete', auth: 'public' }],
                }],
            }],
        });

        expect(() => parseDescriptor(withGate)).toThrow(DescriptorError);
    });
});

describe('what it refuses, and what it says', () => {
    it('names the file when the JSON is broken', () => {
        expect(() => parseDescriptor('{')).toThrow(/mesh\.json is not valid JSON/);
    });

    it('refuses a repository that declares no parts', () => {
        expect(() => parseDescriptor(JSON.stringify({ parts: [] }))).toThrow(DescriptorError);
    });

    it('refuses two parts with one id, and says which', () => {
        // Both artifacts would build. A site naming that id would then be ambiguous about which it
        // loaded, and nothing downstream could tell.
        const dupe = JSON.stringify({
            parts: [
                { kind: 'application', id: 'a', version: '1', entry: 'src/a.ts' },
                { kind: 'extension', id: 'a', version: '1', entry: 'src/b.ts' },
            ],
        });

        expect(() => parseDescriptor(dupe)).toThrow(/"a" is declared twice/);
    });

    it('refuses an entry that leaves the repository', () => {
        for (const entry of ['/etc/passwd', '../../secrets.ts']) {
            expect(() => parseDescriptor(JSON.stringify({
                parts: [{ kind: 'application', id: 'a', version: '1', entry }],
            }))).toThrow(DescriptorError);
        }
    });

    it('refuses a package named with no contracts taken from it', () => {
        expect(() => parseDescriptor(JSON.stringify({
            parts: [{
                kind: 'application', id: 'a', version: '1', entry: 'src/a.ts',
                mesh: [{ package: 'p', version: '1', contracts: [] }],
            }],
        }))).toThrow(DescriptorError);
    });

    it('refuses a field nobody defined, rather than ignoring it', () => {
        // `.strict()`. A `build` key would parse silently and do nothing, and the author would be
        // waiting for a command that is never run.
        expect(() => parseDescriptor(descriptor({ build: 'npm run build' }))).toThrow(DescriptorError);
    });

    it('points at the part that is wrong', () => {
        const bad = JSON.stringify({
            parts: [
                { kind: 'application', id: 'a', version: '1', entry: 'src/a.ts' },
                { kind: 'nonsense', id: 'b', version: '1', entry: 'src/b.ts' },
            ],
        });

        expect(() => parseDescriptor(bad)).toThrow(/parts\.1\.kind/);
    });
});

describe('requirements', () => {
    it('are flattened, sorted and de-duplicated', () => {
        // An artifact's declaration must not depend on how someone typed a list, or the same code
        // would publish under two digests.
        const part = parseDescriptor(JSON.stringify({
            parts: [{
                kind: 'application', id: 'a', version: '1', entry: 'src/a.ts',
                mesh: [
                    { package: 'p', version: '1', contracts: ['b.two', 'a.one'] },
                    { package: 'q', version: '1', contracts: ['a.one'] },
                ],
            }],
        })).parts[0];

        expect(requirementsOf(part!)).toEqual(['a.one', 'b.two']);
    });
});
