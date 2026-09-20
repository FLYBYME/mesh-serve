import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `instanceof MeshError` must not come back.
 *
 * A node loads `@flybyme/mesh` through the ESM loader for its own imports, and again through
 * `require()` when it loads a precompiled `.cjs` part. Under `tsx` -- how a node actually runs --
 * those are two distinct copies, so `instanceof` answers `false` for a genuine `MeshError` and
 * every meaningful status becomes a 500. `isMeshError()` is a `Symbol.for` brand check that
 * survives it.
 *
 * This is a source check rather than a behavioral one, deliberately, and the reason is worth
 * stating: **the behavioral test cannot catch it.** `test/twoNode.integration.test.ts` exercises
 * exactly the path that was broken -- an error crossing from a part on one node to a gateway on
 * another -- and it passes with the bug reinstated, because vitest does not reproduce the module
 * duplication that tsx does. Verified by reverting the fix and watching all seven tests stay green.
 *
 * So the only honest guard at this level is to check the source. Catching it behaviourally would
 * mean running the real CLI in subprocesses under tsx, which is worth doing if this recurs.
 */
const SRC = path.resolve('src');

function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else if (entry.name.endsWith('.ts')) found.push(full);
    }
    return found;
}

describe('errors are recognized across module realms', () => {
    const files = walk(SRC);

    it('finds source to check, rather than silently checking none', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    it('uses isMeshError, never instanceof MeshError', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            for (const [index, line] of content.split('\n').entries()) {
                // Skip the comments that explain the rule.
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
                if (/\binstanceof\s+MeshError\b/.test(line)) {
                    offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('has at least one isMeshError check, so the rule is not vacuous', () => {
        const uses = files.filter((f) => /\bisMeshError\s*\(/.test(fs.readFileSync(f, 'utf-8')));
        expect(uses.length).toBeGreaterThan(0);
    });
});
