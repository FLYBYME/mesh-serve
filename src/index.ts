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

export { ApiService } from './api/api.service.js';
export { McpService, type McpServiceOptions } from './api/mcp.service.js';
export { BuilderService } from './builder/builder.service.js';
export { CatalogService } from './catalog/catalog.service.js';
export { CdnService } from './cdn/cdn.service.js';
export { FleetService } from './fleet/fleet.service.js';
export { Supervisor, loadManifest, topologicalOrder } from './supervisor/Supervisor.js';
export type {
    SupervisorManifest,
    SupervisorServiceEntry,
    SupervisorServiceStatus,
    SupervisorRunStatus,
    SupervisorTestContext,
    SupervisorTestOutcome,
    SupervisorTestRunResult,
} from './supervisor/Supervisor.js';
export { SupervisorService } from './supervisor/SupervisorService.js';

export { TelemService } from './telem/telem.service.js';

// ---------------------------------------------------------------------------- contracts

export * from './api/contracts/api.contract.js';
export * from './builder/contracts/artifact.contract.js';
export * from './catalog/contracts/part.contract.js';
export * from './cdn/contracts/edge.contract.js';
export * from './cdn/contracts/release.contract.js';
export * from './cdn/contracts/site.contract.js';
export * from './fleet/contracts/node.contract.js';
export * from './identity/contracts/identity.contract.js';
export * from './telem/contracts/telem.contract.js';

// ---------------------------------------------------------------------------- mountable by a package

/**
 * **Identity, as a module a package can mount for itself.**
 *
 * Only the *contracts* were exported before, which is the half that lets you name `identity.whoami`
 * and the half that does not let you serve it. So a package wanting real accounts had two options,
 * and both were bad: join the platform's shared multi-tenant fleet — standing up `site`, `release`
 * and organization records to serve six collections nobody else uses — or have no authentication at
 * all. flowboard has none for exactly this reason, and says so in `api.ts`.
 *
 * `createIdentityModule` with `memoryStore()` or `mongoStore(db)` is the third option that should
 * always have existed: one process, its own users, tickets and roles, the same contracts the
 * platform serves. A tool for one operator gets real sign-in without becoming a tenant of anything.
 *
 * Recorded under *Findings from outside this repository* in `spec/roadmap.md` the first time
 * flowboard hit it.
 */
export * from './identity/module.js';
export * from './identity/store.js';
export * from './identity/methods/password.js';

/**
 * **The exposure descriptor, so something other than the api can be built from it.**
 *
 * `describeExposure` is how a site's public surface is computed: it reads `visibility`, applies the
 * site's grants, and answers what may be called and at what gate. `ApiService` uses it to build HTTP
 * routes, and the client generator uses it to emit a typed client — *the same source*, which is the
 * property that keeps a generated client honest.
 *
 * It was not exported, so anything else wanting to derive a surface from the same rules had to
 * reimplement them. flowboard's MCP server does exactly that today with a hardcoded array crossed
 * with four hardcoded actions, and its contracts' `visibility` is consequently decorative — marking
 * something `internal` there changes nothing.
 *
 * Two copies of a rule is how the first one becomes wrong, and an exposure rule is not the one to
 * find that out on.
 */
export * from './api/schema/descriptor.js';
export * from './api/schema/expose.js';
export * from './api/methods/gate.js';

// ---------------------------------------------------------------------------- records

export * from './builder/schema/artifact.js';
export * from './builder/schema/build.js';
export * from './builder/schema/descriptor.js';
export * from './catalog/schema/part.js';
export * from './cdn/schema/edge.js';
export * from './cdn/schema/site.js';
export * from './fleet/schema/node.js';
export * from './telem/schema/telem.js';

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
export * from './telem/methods/config.js';
export * from './telem/methods/rate-limit.js';
export * from './telem/sinks/sink.js';
export * from './telem/sinks/file-sink.js';
export * from './telem/sinks/collection-sink.js';
export * from './telem/sinks/composite-sink.js';
export * from './telem/sinks/default.js';

