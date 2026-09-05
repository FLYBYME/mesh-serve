/**
 * `@flybyme/mesh-serve` — the serving half of the platform.
 *
 * **Importing this registers every contract this package defines.** mesh's `globalContractRegistry`
 * is populated at import time, and it is read by exactly one thing: codegen. So a part repository
 * that declares `"package": "@flybyme/mesh-serve"` in its `mesh.json` gets its types by this module
 * being loaded — which is why the entry has to import the contracts rather than only re-export
 * types, and why an entry that was declared in `package.json` and never written meant the package
 * could not be consumed at all.
 *
 * Nothing here imports `@flybyme/mesh-web`. This is a dependency of the *sites* it serves and never
 * of the browser framework.
 */

// ---------------------------------------------------------------------------- services

export { BuilderService } from './builder/builder.service.js';
export { CatalogService } from './catalog/catalog.service.js';

// ---------------------------------------------------------------------------- contracts

export * from './builder/contracts/artifact.contract.js';
export * from './catalog/contracts/part.contract.js';
export * from './cdn/contracts/site.contract.js';
export * from './identity/contracts/identity.contract.js';

// ---------------------------------------------------------------------------- records

export * from './builder/schema/artifact.js';
export * from './builder/schema/build.js';
export * from './builder/schema/descriptor.js';
export * from './catalog/schema/part.js';
export * from './cdn/schema/site.js';

// ---------------------------------------------------------------------------- the pure work
//
// Exported because it is the part worth reusing and the part worth testing from outside: content
// addressing, range resolution, hostname rules, and the page generator are all pure functions over
// data, with no broker and no database between them and a test.

export * from './builder/methods/content.js';
export * from './builder/methods/lockfile.js';
export * from './catalog/methods/semver.js';
export * from './cdn/methods/hostname.js';
export * from './cdn/methods/page.js';
export * from './cdn/methods/resolve.js';
