import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { discoverPartContracts } from '../../../src/cli/core/discoverPartContracts.js';

/**
 * `filePath` has to name the module that actually implements the contract.
 *
 * It was wrong in 48 of 50 contracts -- every one pointed at its own declaration file, which is why
 * loading a part needed a hand-written register() listing contract-to-handler pairs in the first
 * place. Nothing caught that, because nothing read the field. Things read it now, so this is the
 * check that keeps it honest: a contract whose filePath points back at a `*.contract.ts` has no
 * handler anyone can find, and a part containing one cannot be loaded.
 *
 * CRUD collections are exempt and genuinely different: `defineCrud`'s own filePath names the module
 * that called it, because there is no domain-specific handler for a generic CRUD action --
 * DatabaseMiddleware intercepts those before dispatch. Only `defineContract` is checked here.
 */

const SRC = path.resolve('src');

function partDirs(): string[] {
    return fs.readdirSync(SRC, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC, e.name, 'contracts')))
        .map((e) => e.name);
}

describe('every contract points at real, loadable code', () => {
    const dirs = partDirs();

    it('finds the parts to check, rather than silently checking none', () => {
        expect(dirs).toContain('identity');
        expect(dirs).toContain('catalog');
        expect(dirs).toContain('api');
        expect(dirs).toContain('cdn');
    });

    for (const dir of dirs) {
        describe(dir, () => {
            it('resolves every custom contract to an exported handler', () => {
                // discoverPartContracts throws if a declared filePath is missing, exports no
                // function, or is ambiguous -- the same resolution the build does.
                const { handlers } = discoverPartContracts(path.join(SRC, dir));
                for (const handler of handlers) {
                    expect(fs.existsSync(handler.modulePath), `${handler.toolKey} -> ${handler.modulePath}`).toBe(true);
                }
            });

            it('has no defineContract still pointing at its own declaration file', () => {
                const contractFiles = fs.readdirSync(path.join(SRC, dir, 'contracts'))
                    .filter((f) => f.endsWith('.contract.ts'));

                const selfReferencing: string[] = [];
                for (const file of contractFiles) {
                    const content = fs.readFileSync(path.join(SRC, dir, 'contracts', file), 'utf-8');
                    for (const match of content.matchAll(/export\s+const\s+(\w+)\s*=\s*defineContract\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/g)) {
                        const declared = /\bfilePath\s*:\s*['"]([^'"]+)['"]/.exec(match[2]!)?.[1];
                        if (declared !== undefined && declared.endsWith('.contract.ts')) {
                            selfReferencing.push(`${match[1]!} -> ${declared}`);
                        }
                    }
                }

                expect(selfReferencing).toEqual([]);
            });
        });
    }
});
