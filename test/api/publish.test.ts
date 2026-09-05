/**
 * Turning a descriptor into what the catalog stores.
 *
 * This is the one moment `mesh.json` is read as the genesis object. Everything after it reads the
 * collection, so a value that arrives here wrong is a value nothing downstream will question.
 */

import { describe, expect, it } from 'vitest';

import { parseArgs, versionFrom } from '../../src/api/publish-cli.js';
import { parseDescriptor } from '../../src/builder/schema/descriptor.js';

const COMMIT = 'a'.repeat(40);

const partOf = (part: Record<string, unknown>, kernel?: string) => {
    // One shape, always: a repository builds parts, even when it builds one.
    const descriptor = parseDescriptor(JSON.stringify({
        ...(kernel === undefined ? {} : { kernel }), parts: [part],
    }));
    return { part: descriptor.parts[0]!, kernel: descriptor.kernel };
};

describe('what a part publishes as', () => {
    it('carries the commit, which is the only identity that means anything', () => {
        const { part, kernel } = partOf(
            { kind: 'extension', id: 'auth', version: '0.1.0', entry: 'src/index.ts' },
            '^0.3',
        );

        expect(versionFrom(part, COMMIT, kernel)).toMatchObject({
            version: '0.1.0', commit: COMMIT, entry: 'src/index.ts', kernel: '^0.3',
        });
    });

    it('flattens and sorts the contracts it calls', () => {
        // Grouped by package in the descriptor so a build can verify them; flat is what a site
        // checks against its grants. Sorted, so a reordered file is not a different version.
        const { part, kernel } = partOf({
            kind: 'application', id: 'a', version: '1.0.0', entry: 'src/a.ts',
            mesh: [
                { package: 'p', version: '1', contracts: ['b.two', 'a.one'] },
                { package: 'q', version: '1', contracts: ['a.one'] },
            ],
        });

        expect(versionFrom(part, COMMIT, kernel).requires).toEqual(['a.one', 'b.two']);
    });

    it('gives a kernel no kernel', () => {
        // The one thing that has no kernel. A range here would be a package depending on itself.
        const { part } = partOf({
            kind: 'kernel', id: 'mesh-web', version: '0.3.0', entry: 'src/index.ts',
        });

        expect(versionFrom(part, COMMIT, '^0.3').kernel).toBeUndefined();
    });

    it('carries required parts through', () => {
        const { part, kernel } = partOf({
            kind: 'application', id: 'a', version: '1.0.0', entry: 'src/a.ts',
            requiredParts: [{ id: 'auth', version: '^0.1' }],
        });

        expect(versionFrom(part, COMMIT, kernel).requiredParts)
            .toEqual([{ id: 'auth', version: '^0.1', optional: false }]);
    });
});

describe('arguments', () => {
    it('defaults the descriptor and nothing else', () => {
        const args = parseArgs([]);
        expect(args.descriptor).toBe('mesh.json');
        // A publisher is who may build this part with whatever credential a builder holds, so
        // guessing one would be guessing at an authorization boundary.
        expect(args.publisher).toBeUndefined();
        expect(args.repository).toBeUndefined();
    });

    it('reads what it is given', () => {
        const args = parseArgs(['--publisher', 'flybyme', '--repository', 'https://x/y.git', '--dry-run']);
        expect(args).toMatchObject({
            publisher: 'flybyme', repository: 'https://x/y.git', dryRun: true,
        });
    });
});
