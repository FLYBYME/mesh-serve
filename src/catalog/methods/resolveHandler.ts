import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHandlerResolver, findPackageRoot } from '@flybyme/mesh/node';

/**
 * `loadDomain`'s handler resolver, bound to this package.
 *
 * The resolver itself lives in `@flybyme/mesh/node` -- every repo on contract-driven placement
 * needs the same thing, and copies of it would drift. All that is package-specific is the root
 * that contracts' `filePath`s are relative to, which cannot be derived inside mesh (it would find
 * mesh's own root, never the caller's).
 *
 * Resolved from the *package root* rather than relative to this file, because this module runs
 * from two genuinely different places: `dist/catalog/methods/` in a compiled build, and
 * `src/catalog/methods/` under tsx or vitest. A path relative to `import.meta.url` is correct in
 * exactly one of those.
 */
const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

export const resolveHandler = createHandlerResolver({
    root: PACKAGE_ROOT,
    // The import has to happen *here*, in this package's own module graph. Under tsx or vitest
    // only modules that runtime owns get transformed, so the same call made from inside
    // node_modules refuses a .ts handler with "Unknown file extension".
    load: (url) => import(url),
});
