# D2: Routes Come From the Record Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-6`  
**Branch:** `dispatch/6`  
**Task:** **D2** — Routes come from the record (`src/api/api.service.ts`, `src/api/methods/routes.ts`, `src/api/tools/describe.ts`, `test/api/routes.test.ts`, `test/integration/api.test.ts`)  
**Milestone Status:** D1, D2, and D3 closed. M3 continues toward D4 (exposure hash) and A4 (identity CRUD rewrite).

---

## 1. Executive Summary

Roadmap item **D2** states:
> *Host → site → release → `mesh[]` → routes, exactly as the cdn resolves Host → site → artifact. Same cache, same invalidation. It makes the gate **per site**: one site may expose `domains.zone_find` as public while another requires `user`.*

Prior to D2:
- `ApiService` mounted routes directly from `site.mesh.contracts` without taking the site's active release into account.
- Unused grants in `site.mesh` were mounted even if the deployed release required none of them.
- `api_describe` bypassed `cdn.resolve_site` and directly called `site.find_one` (which fails under scoped collections).
- Caching on `ApiService` lacked synchronization with site deploys and releases.

With **D2** implemented:
1. **Dynamic Route Resolution from Site & Release:**
   - Incoming request `Host` is normalized and resolved to a `Site` record via `cdn.resolve_site`.
   - If `site.releaseHash` is present, `ApiService` fetches the corresponding `Release` record.
   - `routeTable()` takes `release.requires` as an input parameter and filters the routes so that **only contracts required by the active release are exposed**. Unused grants in `site.mesh` are omitted.
2. **Matching CDN Caching and Invalidation:**
   - Route tables are cached in `ApiService.routes` keyed by `${site.id}:${releaseHash}:${site.updatedAt?.toISOString() ?? ''}`.
   - Host-to-site resolution is cached in `ApiService.sites` with negative caching for unknown hostnames (avoiding repeated database lookups for 404s).
   - Invalidation subscribes to both `cdn.site_deployed` and `site.updated` broker events, evicting stale host entries immediately upon deploy or site mutation.
3. **No Second Door Added:**
   - Both `ApiService.siteFor` and `api_describe` reuse `cdn.resolve_site`.
   - The number of unscoped reads across the entire codebase remains strictly **1** (`src/cdn/tools/resolve_site.ts:47`).
4. **Clean Types & Zero Casts:**
   - Zero `as any`, zero `as never`, zero casts.
   - `globalContractRegistry.get(key)` returns `ToolContract<ZodTypeAny, ZodTypeAny> | undefined`, directly satisfying `ContractLookup`.
5. **Verification:**
   - All 315 tests pass across 26 test suites (5 new tests: 2 unit tests in `test/api/routes.test.ts`, 3 integration tests in `test/integration/api.test.ts`).

---

## 2. Reusing `cdn.resolve_site` vs. Adding a Door

We **reused `cdn.resolve_site`** and added **zero new doors**.

### The Architectural Argument
Under mesh v2.2.0, `siteCrud` is configured with `scopedBy: 'tenantId'`. Every standard CRUD read (`site.find`, `site.find_one`, `site.get`) requires an authenticated caller with a resolved tenant scope. A browser fetching an HTML page or hitting an API endpoint is anonymous; it carries no caller scope.

In dispatch 3a, `cdn.resolve_site` was introduced to solve this exact dilemma for the serving path:
> *A door that opens into the same locked room is not a second door. So the bypass is real and it is confined to these four lines, where the invariant is stated and checkable: **one site, by exact hostname, and nothing here can enumerate**.*

If `ApiService` or `api_describe` had used `Database.repo()` directly or invented an `api.resolve_site` contract, it would have introduced a second bypass into the database, violating the repository's core rule: *one function with a stated invariant can be reviewed; a serving path with database access cannot.*

Instead:
- `ApiService.siteFor(host)` calls `this.caller.call(resolveSiteContract, { host })`.
- `api_describe` calls `ctx.caller.call(resolveSiteContract, { host: input.host })`.
- Neither touches `Database.repo()` or bypasses CRUD internally.
- The single serving-path door is shared between the CDN (which serves artifacts and pages) and the API (which serves calls).

### Count of Unscoped Reads Across the Repository
There is exactly **1** unscoped read in the entire codebase:
- `src/cdn/tools/resolve_site.ts`, line 47:
  ```ts
  const [found] = await this.siteRepo().find({ query: { host }, limit: 1 });
  ```
Zero other unscoped database reads exist in `src/`.

---

## 3. The Three Core Architectural Questions

### Question 1: What happens to a request that arrives between a deploy and cache invalidation?
When `cdn.deploy` executes:
1. It updates the site record in MongoDB (`releaseHash` is set to the new release hash, and `updatedAt` is bumped).
2. It publishes the `cdn.site_deployed` event containing `{ siteId, host, releaseHash, tenantId }`, and `site.update` emits `site.updated`.

If an incoming API request arrives at an edge node in the sub-millisecond interval *before* the invalidation event is processed:
- The request hits `ApiService.siteFor(host)` which returns the currently cached `Site` record.
- `ApiService.tableFor(site)` looks up the route table keyed on `${site.id}:${site.releaseHash}:${site.updatedAt}`.
- **The request is served atomically and consistently against the old release and its declared contracts.**
- It never executes against a torn or half-migrated state (such as the new release with the old site gates, or vice versa).
- As soon as the event loop delivers `cdn.site_deployed` or `site.updated`, `this.sites.delete(host)` evicts the hostname cache.
- The very next request fetches the new site record, loads the new release, derives the new cache key, computes the new route table, and serves subsequent requests against the new deployment.

### Question 2: Can a route be exposed that the release does not contain?
**No.**

A site record's `mesh.contracts` defines what the site operator *authorizes* and at what gate (e.g. `auth.whoami` at `public`, `todos.create` at `user`). However, the release defines what the composed parts actually *require* in `release.requires`.

In `routeTable(site, lookup, requires)`:
```ts
const requiredSet = requires !== undefined ? new Set(requires) : undefined;
const contracts = (requiredSet !== undefined
    ? site.mesh.contracts.filter(c => requiredSet.has(c.contract))
    : site.mesh.contracts
).map(...)
```

If `site.mesh.contracts` contains grants for contracts that `release.requires` does not list, those contracts are **filtered out of the route table**. Any HTTP request attempting to invoke an unrequired contract will not match any route in the table and will return a clean `404 Not Found`.

Furthermore, at composition time, `cdn.compose` runs `checkComposition`, which flags unrequired grants as `unusedGrants` warnings, alerting operators of extraneous exposure.

### Question 3: What does a part's declared `requires` mean here?
The division of responsibility between part, release, and site is deliberate:
1. **Parts declare requirements (`requires`):** A part's code needs certain services/contracts to function (e.g., `@flybyme/auth` requires `identity.issue`, `identity.whoami`). It declares them in `mesh.json`.
2. **Releases aggregate requirements (`release.requires`):** At compose time (`cdn.compose`), the requirements of all composed parts are collected into a canonical union on the `Release` record.
3. **Sites grant permissions and choose gates (`site.mesh.contracts`):** A site operator decides whether a contract is accessible, and at what gate (`public`, `user`, or specific roles).
4. **The Principle:** *A part must never choose its own gate.* If a part could declare its own gate, installing an extension or third-party part could silently open unauthenticated or privileged endpoints on the host without operator approval.
5. **The API Mounts the Intersection:** The API server mounts only those contracts that are both **required by the release** and **granted by the site**, enforcing the exact gate configured by the site operator.

---

## 4. Notes for `spec/unread.md`

- **`release.requires` (`src/cdn/schema/release.ts`):**
  - Previously: `release.requires` was computed at compose time and checked by `checkComposition` for unmet dependencies and unused grants, but was unread by the serving path.
  - Now: `release.requires` is an active runtime input to `ApiService.tableFor` and `api_describe`. The serving path reads `release.requires` to prune routes and enforce that only parts' required contracts are exposed.

---

## 5. Verification & Test Suite

### New Unit Tests (`test/api/routes.test.ts`)
- Verified that `routeTable()` filters out contracts absent from `requires`.
- Verified that `routeTable()` returns an empty route table when `requires` is empty, even if `site.mesh.contracts` contains grants.

### New Integration Tests (`test/integration/api.test.ts`)
- **Per-site gates on one node:** Two sites (`public.test` and `gated.test`) pointing to the same release and contract (`echo`). Site 1 exposes it as `public` (accessible without token); Site 2 exposes it as `user` (refuses anonymous request with 401, accepts valid ticket).
- **Dynamic deploy without restart:** Deployed `releaseA` (requiring `echo`); verified `POST /api/echo` succeeds. Deployed `releaseB` (requiring `reverse`, omitting `echo`); verified `POST /api/echo` immediately returns 404 and `POST /api/reverse` succeeds without restarting the `ApiService`.
- **Unknown hostname & negative caching:** Verified unknown host returns 404, caches negative lookup, and handles missing release with 503.

### Full Test Suite
- Total test files: 26 passed
- Total tests: 315 passed (0 failed, 0 skipped)
- Typecheck: Clean (`tsc --noEmit` exited 0)
