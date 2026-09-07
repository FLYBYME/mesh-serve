# D4: The Exposure Hash Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-8`  
**Branch:** `dispatch/8`  
**Task:** **D4** — The exposure hash (`src/cdn/schema/release.ts`, `src/api/schema/descriptor.ts`, `src/api/methods/routes.ts`, `src/api/methods/client.ts`, `src/api/client-cli.ts`, `src/api/contracts/api.contract.ts`, `src/api/tools/describe.ts`, `src/api/api.service.ts`, `spec/roadmap.md`, `spec/unread.md`, `test/api/exposure.test.ts`, `test/integration/api.test.ts`)  
**Milestone Status:** **Milestone 3 (M3) Complete.** All items (D1, D2, D3, D4, A4) are closed. Roadmap advances to Milestone 4 (M4).

---

## 1. Executive Summary

Roadmap item **D4** states:
> *The API reports it, the generated client carries it, a mismatch is an error rather than a confusing 404 three calls later. A client generated from one exposure and pointed at an API serving another is a lie the compiler vouches for.*

Prior to D4:
- The system suffered from an architectural contradiction between **C1** and **D2**:
  - A release is site-independent by design (C1) and shared across hostnames.
  - Exposure gates are per-site (D2), allowing two sites on the same release to expose `domains.zone_find` with different gates (e.g., `public` vs. `user`).
  - Consequently, `release.exposure` was impossible to compute at release composition time without knowing the site's gates. It remained unpopulated and unread (flagged in `spec/unread.md` §1).
- Generated clients lacked a mechanism to verify that their compiled contract shapes and gates agreed with what the runtime API actually exposed.
- Route tables computed a gate hash on `exposure`, but lacked a stable, gate-independent hash over contract shapes (`shapeHash`).
- API responses did not expose shape hashes or validate client exposure headers against the active route table.

With **D4** completed:
1. **The Core Contradiction Resolved via Two Distinct Hashes:**
   - **Shape Hash (`shapeHash`):** Hashes contract keys, HTTP methods, route paths, input JSON schemas, and output JSON schemas. Completely site-independent and gate-independent. Answers: *is this generated client stale?*
   - **Gate Hash (`exposure`):** Hashes contract keys, HTTP methods, route paths, and actual gate levels (`auth` level or `permission`). Per-site, updates on deploy or site record mutation without rebuilding parts.
   - **Release Contract Requirements:** Cleanly tracked by `release.requires` (strings of `domain.action`), checked at deploy time against `site.mesh` (`cdn.deploy`).
2. **`release.exposure` Resolved in `spec/unread.md`:**
   - Removed from `ReleaseSchema` and test mock data.
   - Documented in `spec/unread.md` §1: promises kept by removing the unkeepable field and replacing it with verifiable shape/gate hashes and deploy-time composition checks.
3. **Client Meets API Exposure Verification:**
   - Implemented `diffExposure`, `assertExposureMatch`, and `verifyClientExposure` with dedicated `ExposureMismatchError`.
   - Detects missing contracts, method changes, path changes, input schema changes, output schema changes, and gate changes.
   - Produces exact, actionable failure messages (e.g. `Exposure mismatch: Contract "domains.zone_find" input schema changed.`, `Exposure mismatch: Contract "domains.zone_delete" is not exposed by the API.`).
4. **Runtime API Headers & Request Validation:**
   - `ApiService` reports `x-exposure` (gate hash) and `x-exposure-shape` (shape hash) on all API responses and exposes both via CORS headers.
   - If an incoming request specifies `x-exposure` or `x-exposure-shape`, `ApiService.handle` verifies them against the active route table and immediately returns HTTP 409 `EXPOSURE_MISMATCH` if either differs.
   - `api.describe` returns both `exposure` and `shapeHash` alongside described calls and JSON schemas.
5. **Zero Casts and Full Test Verification:**
   - Zero `as any`, zero `as unknown`, zero type casts across all new and modified code.
   - All 344 tests pass across 28 test suites (including 17 unit tests in `test/api/exposure.test.ts` and 5 new integration tests in `test/integration/api.test.ts`).

---

## 2. Resolving the C1 vs. D2 Contradiction

### The Architectural Contradiction
- Under **C1** (content-addressed releases), releases are composed purely over artifact digests and dependency policies. A single release can be deployed across dozens of hostnames and organizations.
- Under **D2** (routes come from the record), a site's record (`site.mesh`) determines the exposure gates. One site might expose `domains.zone_find` as `public`, while an internal admin site exposes it as `user` or `permission:domains.read`.
- Therefore, a release *cannot* compute an exposure hash over gates at compose time (`cdn.compose`), because it has no site context and must not know which site will deploy it.

### The Two-Hash Solution

| Hash | Where it Lives | What it Hashes | Invariance Property | Primary Question Answered |
|---|---|---|---|---|
| **Shape Hash** (`shapeHash`) | `RouteTable.shapeHash`<br>`ExposureDescriptor.shapeHash`<br>`api.describe.shapeHash`<br>`x-exposure-shape` header | Contract keys, HTTP methods, paths, input JSON schemas, output JSON schemas, destructive flag, stream flag, error lists. | Gate-independent, site-independent. Stable across key reorderings and environments. | *Is this generated client stale or calling different types/methods?* |
| **Gate Hash** (`exposure`) | `RouteTable.exposure`<br>`ExposureDescriptor.exposure`<br>`api.describe.exposure`<br>`x-exposure` header | Contract keys, HTTP methods, paths, and gates (`auth` level or `permission`). | Per-site. Changes when a gate changes or when routes are added/removed. | *Are the security gates and access levels identical to what the client expects?* |

### Release Requirements Verification
Releases do not store exposure hashes; instead, `release.requires` records the string keys of all contracts that the composed parts call.
When `cdn.deploy` runs:
```ts
const granted = new Set(site.mesh.flatMap((dependency) =>
    dependency.contracts.map((contract) => contract.key)));

const ungranted = release.requires.filter((key) => !granted.has(key));
if (ungranted.length > 0) {
    throw new ClientError(
        `${host} does not expose ${ungranted.join(', ')}, and this release calls ` +
        `${ungranted.length === 1 ? 'it' : 'them'}. ...`,
        'contract_not_exposed', 409,
    );
}
```
This guarantees that missing contracts are rejected at deploy time before any browser or API client reaches them.

---

## 3. Client Verification and Diffs

### Exact Error Messages
When a client generated against one descriptor meets an API serving another, `diffExposure` identifies the precise contract and aspect that differed, and `assertExposureMatch` / `verifyClientExposure` throws `ExposureMismatchError`:

1. **Missing Contract:**
   `Exposure mismatch: Contract "domains.zone_delete" is not exposed by the API.`
2. **Input Schema Difference:**
   `Exposure mismatch: Contract "domains.zone_find" input schema changed.`
3. **Output Schema Difference:**
   `Exposure mismatch: Contract "domains.zone_find" output schema changed.`
4. **HTTP Method Difference:**
   `Exposure mismatch: Contract "domains.zone_find" method changed from GET to POST.`
5. **Route Path Difference:**
   `Exposure mismatch: Contract "domains.zone_find" path changed from /zones to /v2/zones.`
6. **Gate Difference:**
   `Exposure mismatch: Contract "domains.zone_find" gate changed from public to user.`

The caller gets a named error identifying the exact failure upfront, rather than experiencing an unexpected 404 or a JSON deserialization failure deep within an application workflow.

### Gate Tolerance Option
For tooling, staging environments, or testing scenarios where contract schemas must match but gates may legitimately differ across environments, `checkGates: false` permits verifying shape compatibility while ignoring gate differences:
```ts
verifyClientExposure(clientDescriptor, apiDescriptor, { checkGates: false });
```

---

## 4. Runtime API Serving Path

### Response Headers
Every API response served by `ApiService` carries both headers:
- `x-exposure`: The active route table's gate hash.
- `x-exposure-shape`: The active route table's shape hash.

Both headers are declared in CORS `access-control-expose-headers` and `access-control-allow-headers`.

### Request Header Validation
When an API client sends `x-exposure` or `x-exposure-shape` headers in its request, `ApiService.handle` compares them directly against the active route table before routing or gate execution:
- Mismatched `x-exposure`: Responds with HTTP 409 and `error: 'EXPOSURE_MISMATCH'`.
- Mismatched `x-exposure-shape`: Responds with HTTP 409 and `error: 'EXPOSURE_MISMATCH'`.

---

## 5. Verification Results

### Test Coverage
- **Unit Tests (`test/api/exposure.test.ts` — 17 tests):**
  - Proves that changing a gate changes the gate hash and does *not* change the shape hash.
  - Proves that reordering declarations does not change shape hash or gate hash.
  - Proves that reordering error lists does not change the shape hash.
  - Proves that changing input schema, output schema, HTTP method, or path changes the shape hash.
  - Proves that `routeTable` produces matching shape hashes across different gates.
  - Proves that `verifyClientExposure` passes on matching exposures and fails with specific `ExposureMismatchError` on missing contracts, method changes, path changes, input schema changes, output schema changes, and gate changes.
  - Proves that `checkGates: false` ignores gate differences when shapes match.
  - Proves direct verification of client descriptors against `RouteTable`.
  - Proves that `emitClient` outputs both `exposure` and `shapeHash` in code and generated headers.
- **Integration Tests (`test/integration/api.test.ts` — 24 tests):**
  - Verified `api.describe` reports both `exposure` and `shapeHash`.
  - Verified `GET /api/identity/whoami` returns `x-exposure` and `x-exposure-shape` matching `api.describe`.
  - Verified that sending matching exposure headers succeeds.
  - Verified that sending mismatched `x-exposure` or `x-exposure-shape` returns HTTP 409 `EXPOSURE_MISMATCH`.
  - Verified `verifyClientExposure` against running API description.
- **Full Suite:**
  - 344 tests passing across 28 test files.
  - `npm run typecheck` clean.
  - Zero type assertions / casts (`as any`, `as unknown`).

---

## 6. Milestone 3 Sign-off

With D4 closed, **Milestone 3 is complete**:
- **D1:** Moved the API out of mesh-api.
- **D2:** Routes come from the site record; gates are per-site.
- **D3:** Scopes reach `defineCrud`.
- **D4:** Exposure and shape hashes report, verify, and reject mismatches.
- **A4:** Identity rewritten on `defineCrud`.

Roadmap M3 is marked complete in `spec/roadmap.md`, and the system is ready for **M4** (marketplace / third-party part publishing).
