/**
 * `@flybyme/mesh-serve` — the serving half of the platform.
 *
 * **Importing this registers every contract this package defines.** mesh's `globalContractRegistry`
 * is populated at import time and read by codegen, so a repository declaring
 * `"package": "@flybyme/mesh-serve"` in its `mesh.json` gets its types by this module being loaded.
 * An entry that only re-exported types would leave the package unconsumable.
 *
 * Nothing here imports `@flybyme/mesh-web`. This is a dependency of the *sites* it serves, never of
 * the browser framework.
 */

// ---------------------------------------------------------------------------- services

export { IdentityService, FIRST_BOOT_EMAIL, type IdentityServiceOptions } from './identity/identity.service.js';
export { ServeService } from './serve/serve.service.js';
export { ApiService, type ApiServiceOptions } from './serve/api/api.service.js';
export { BuildService, type BuildServiceOptions } from './build/build.service.js';

// ---------------------------------------------------------------------------- collections
//
// One module per collection, because mesh dispatches a CRUD hook to the module whose `domain`
// matches. See `./collection.ts` — this is the difference between a narrowing hook that runs and
// one that looks like it does.

export { CollectionService, ownRowsOnly, type CollectionHooks, type CollectionOptions, type CrudAction } from './collection.js';
export { collectionServices } from './collections.js';

// ---------------------------------------------------------------------------- bringing one up

export { bootstrap, CONTROL_CONTRACTS, type BootstrapOptions, type BootstrapResult } from './bootstrap.js';

// ---------------------------------------------------------------------------- contracts

export * from './identity/contracts/identity.contract.js';
export * from './serve/contracts/site.contract.js';
export * from './build/contracts/build.contract.js';

// ---------------------------------------------------------------------------- records

export * from './identity/schema/principals.js';
export * from './identity/schema/tickets.js';
export * from './serve/schema/site.js';
export * from './build/schema/artifact.js';
export * from './build/schema/catalog.js';
export * from './build/schema/descriptor.js';
export * from './build/schema/source.js';

// ---------------------------------------------------------------------------- the pure work
//
// Exported because it is the part worth reusing and the part worth testing from outside: hostname
// rules, the gate, routing, the descriptor and the error mapping are all pure functions over data,
// with no broker and no database between them and a test.

export * from './identity/methods/password.js';
export * from './serve/methods/descriptor.js';
export * from './serve/methods/errors.js';
export * from './serve/methods/gate.js';
export * from './serve/methods/hostname.js';
export * from './serve/methods/routes.js';
export * from './build/methods/blobs.js';
export * from './build/methods/content.js';
export * from './build/methods/source.js';
