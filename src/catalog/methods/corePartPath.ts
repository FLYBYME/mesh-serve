import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import type { CorePartName } from '../contracts/corePart.contract.js';

/**
 * Resolved from the *package root* (the nearest ancestor with a package.json), not relative to this
 * file -- this module runs from two genuinely different places: `dist/catalog/methods/` when the
 * compiled build runs, and `src/catalog/methods/` when it runs from source under tsx/vitest, which
 * is how the CLI is run in development. A path relative to `import.meta.url` is correct in exactly
 * one of those and silently wrong in the other ("Cannot find module .../src/parts/identity.cjs"),
 * which is precisely how this was found.
 *
 * The bundles themselves always live in `dist/parts` either way -- they're build output
 * (`cli/core/buildCoreParts.ts`), never source.
 */
export function findPackageRoot(startDir: string): string {
    let dir = startDir;
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`Could not locate mesh-serve's package root walking up from "${startDir}".`);
        }
        dir = parent;
    }
}

const CORE_PARTS_DIR = path.join(findPackageRoot(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'parts');

export function corePartPath(name: CorePartName): string {
    return path.join(CORE_PARTS_DIR, `${name}.cjs`);
}
