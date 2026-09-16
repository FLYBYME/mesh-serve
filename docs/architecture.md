# System Architecture

`@flybyme/mesh-serve` is a modular runtime providing end-to-end lifecycle management for web applications on top of `@flybyme/mesh`. It unifies compilation, content-addressed storage, envelope synthesis, static CDN delivery, identity federation, and dynamic REST exposure into a single node.

---

## Core Services

The platform is structured into four service modules, all mounted on a single [`MeshApp`](file:///home/ubuntu/code/mesh-serve/src/cli/commands/start.ts#L54) broker instance:

### 1. [`CatalogService`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L17) (`serve.catalog`)
* **Domain**: `serve.catalog`, `serve.repo`, `serve.part`, `serve.composition`, `serve.artifact`, `serve.release`
* **Role**: The build and release management engine.
* **Responsibilities**:
  * Tracks source code repositories ([`Repo`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/repo.contract.js)) and modular components ([`Part`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/part.contract.js)).
  * Manages compilation via `esbuild` for different part kinds (`kernel`, `application`, `extension`, `driver`, `theme`).
  * Emits immutable, content-addressed asset directories stored under `~/.mesh/artifacts/<hash>/`.
  * Assembles parts and kernel drivers into composite [`Release`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/release.contract.js) records identified by deterministic content hashes.
  * Runs a background worker ([`watchRelease`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L105)) that polls for and builds pending artifacts.

### 2. [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L95) (`serve.cdn`)
* **Domain**: `serve.cdn`, `serve.site`
* **Role**: The frontend HTTP host router and web envelope generator.
* **Responsibilities**:
  * Binds public hostnames to [`Site`](file:///home/ubuntu/code/mesh-serve/src/cdn/contracts/site.contract.js) records.
  * Synthesizes HTML envelopes dynamically, generating an inline ES boot module that calls `@flybyme/mesh-web`'s `start()` with runtime configuration, policies, and parts.
  * Constructs dynamic browser import maps pointing bare package specifiers to immutable artifact URLs.
  * Calculates and injects SHA-256 Content Security Policy (CSP) hash allowlists for inline scripts, preventing XSS without allowing `'unsafe-inline'`.
  * Streams static web assets from `/assets/<artifactHash>/<path>` with HTTP conditional caching (`ETag`, `Last-Modified`, 304).
  * Handles site maintenance modes and redirects.

### 3. [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L59) (`serve.api`)
* **Domain**: `serve.api`, `serve.expose`, `serve.want`
* **Role**: The dynamic REST gateway into the backend mesh.
* **Responsibilities**:
  * Maps `@flybyme/mesh` service contracts to REST endpoints via [`Expose`](file:///home/ubuntu/code/mesh-serve/src/api/contracts/expose.contract.js) records.
  * Matches incoming HTTP paths, extracting URL parameters and query/body payloads.
  * Authenticates requests via Bearer tokens (User Tickets or API Tokens).
  * Enforces role-based ([`identity.hasRole`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/hasRole.ts#L11)) and permission-based ([`identity.permits`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/permits.ts#L11)) gates before invoking contracts.
  * Exposes runtime schema metadata at `/api/_describe` and generates browser-safe TypeScript/Zod API clients.
  * Bootstraps a default API on `api.localhost` for platform onboarding.

### 4. [`IdentityService`](file:///home/ubuntu/code/mesh-serve/src/identity/identity.service.ts#L37) (`identity`)
* **Domain**: `identity`
* **Role**: Multi-tenant identity, authentication, and authorization provider.
* **Responsibilities**:
  * Manages user accounts ([`User`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/user.contract.js)) with `scrypt` password hashing and salting.
  * Partitions tenants via organizations ([`Organization`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/organization.contract.js)) and user memberships ([`Membership`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/membership.contract.js)).
  * Issues and validates sliding-window session tickets ([`Ticket`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/ticket.contract.js)) and persistent API tokens ([`ApiToken`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/apiToken.contract.js)).
  * Evaluates caller roles and wildcard permission patterns (`identity.*`, `serve.*`).
  * Seeds the default `platform` organization and `operator` role on first boot.

---

## Complete Application Lifecycle

```
1. DEFINE           2. COMPILE         3. COMPOSE          4. DEPLOY          5. SERVE
+-------------+     +--------------+   +--------------+    +-------------+    +---------------+
| serve.repo  | --> | serve.part   |-->| serve.       | -> | serve.site  | -> | Host Request  |
| (git remote)|     | requestBuild |   | composition  |    | deploy      |    | HTML Envelope |
+-------------+     +-------+------+   +-------+------+    +------+------+    +-------+-------+
                            |                  |                  |                   |
                            v                  v                  v                   v
                     ~/.mesh/artifacts/  serve.release     serve.want         /assets/<hash>/
                     <hash>/entry.js     (pinned hash)     (reconciled)       Stream & CSP
```

### Stage 1: Registration
1. A Git repository is registered in `serve.repo` (`url`, `defaultBranch`).
2. One or more components are declared in `serve.part` (`kind`, `path`, `entryPoint`, `imports`, `key`). Keys follow the namespaced format `<org-slug>/<part-name>`.

### Stage 2: Compilation & Artifact Hashing
1. A build is requested via [`serve.artifact.requestBuild`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/requestBuild.ts#L7).
2. The [`CatalogService`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L17) checks out the Git repository at the specified ref.
3. Sibling parts with declared `imports` are resolved as external modules.
4. `esbuild` bundles the code into ESM. For kernel parts, drivers are synthesized into the bundle entry.
5. Contract dependencies are read from `mesh.wants.json`.
6. Output files are hashed with SHA-256 and stored in `~/.mesh/artifacts/<hash>/`.

### Stage 3: Composition & Release
1. A `serve.composition` groups a kernel part, optional theme, drivers, and application/extension parts.
2. Invoking [`serve.composition.compose`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/compose.ts#L62) resolves the latest successful artifact for each part.
3. A deterministic SHA-256 release hash is generated from the sorted part-to-artifact mapping and persisted in `serve.release`.

### Stage 4: Deployment & Wants Reconciliation
1. A site in `serve.site` is deployed to a release via [`serve.cdn.deploy`](file:///home/ubuntu/code/mesh-serve/src/cdn/tools/deploy.ts#L17).
2. The deployment validates tenant ownership and application compatibility (`composition.key === site.application`).
3. Contract requirements (`wants`) from all parts in the release are merged and reconciled into `serve.want` records, deleting stale dependencies and creating new ones.

### Stage 5: Serving
1. **CDN Traffic**: When an HTTP request reaches `CdnService`, [`resolveHostname`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L174) resolves the site. Asset requests (`/assets/<hash>/<path>`) stream directly from the artifact directory. Root and page requests render an HTML envelope containing the inline boot module and strict CSP hashes.
2. **API Traffic**: When a request reaches `ApiService`, [`findRoute`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L255) identifies the exposed contract, [`resolveCaller`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L222) parses bearer authentication, [`checkGate`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L282) verifies permissions, and the broker dispatches the call into the mesh.

---

## Multi-Tenancy & Security Model

* **Tenant Root**: Every tenant is represented by an [`Organization`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/organization.contract.js) in `identity`.
* **Collection Scoping**: Repos, parts, compositions, artifacts, releases, sites, APIs, and expose rules declare `scopedBy: 'tenantId'`. Database operations automatically isolate data to the caller's tenant.
* **Context Propagation**: Calls crossing the broker carry `meta: { tenant_id, user: { id, tenant_id } }`. Unauthenticated calls carry `meta: { tenant_id }` so that public endpoints can still read scoped tenant collections without security bypasses.
* **Immutability**: Artifacts and releases are strictly content-addressed. Once written, artifact directories and release hashes never mutate, guaranteeing that caching is deterministic and tamper-proof.
