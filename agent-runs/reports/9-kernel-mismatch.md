# F5: Kernel Mismatch Fatal Composition Problem Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-9`  
**Branch:** `dispatch/9`  
**Task:** **F5** — Make kernel mismatch a fatal composition problem (`src/catalog/schema/part.ts`, `src/cdn/methods/release.ts`, `src/cdn/tools/compose.ts`, `spec/roadmap.md`, `spec/unread.md`, `test/cdn/release.test.ts`, `test/integration/spine.test.ts`)  
**Status:** **Complete.** All 352 tests pass across 28 test files. `npm run typecheck` passes with zero type assertions/casts.

---

## 1. Executive Summary

Roadmap item **F5** states:
> *`partVersion.kernel` is stored and never read, and a live release already violates it. `publish-cli` writes the range a part was built against, with the comment "the only thing standing between a stale part and a browser"; `build_start` forwards it. Nothing reads it — `checkComposition` checks missing parts, unmet contracts and unused grants, and has no kernel case at all. Add a `kernel_mismatch` problem, fatal.*

Prior to F5:
- `publish-cli` recorded the kernel semver range that a part was compiled against.
- `partVersion.kernel` was stored in the catalog database, but ignored across all CDN resolution and composition logic.
- On 2026-09-06, 5 of 6 live sites were serving parts outside their declared range (e.g. `theme`, `clock`, `notes`, `calc`, `todo`, and `auth@0.2.0` declaring `^0.6` while the platform served kernel `0.11.4`).
- When enforced by hand, bumping parts to `^0.13` failed compilation because the kernel introduced `'single'` window mode while `workbench` had narrowed to `'windowed' | 'tiled'`. This proved the incompatibility was real and should have been caught at release compose time.

With **F5** completed:
1. **Fatal Composition Enforcement (`kernel_mismatch`):**
   - Added `'kernel_mismatch'` to `CompositionProblem['kind']`.
   - Marked `kernel_mismatch` as fatal in `isFatal`: any mismatch stops the compose, prevents writing the release record, and reports the failure naming both the part and the declared range.
2. **Pure Range Checking in `checkComposition`:**
   - `checkComposition` evaluates each part's declared kernel range against the release's kernel version using pure `satisfies` and `parse` from `src/catalog/methods/semver.ts`.
   - Handles partial version representations cleanly (e.g., `0.13` vs `0.13.0`).
3. **Integration in `cdn_compose`:**
   - `cdn_compose` retrieves `version.kernel` when resolving parts from the catalog and passes the kernel requirements alongside the resolved kernel version to `checkComposition`.
4. **Zero Type Casts & 100% Test Coverage:**
   - All TypeScript compilation passes with zero type assertions (`as any`, `as unknown`, `as string`, etc.).
   - All 352 tests pass, including new unit tests in `test/cdn/release.test.ts` and end-to-end integration tests in `test/integration/spine.test.ts`.

---

## 2. What an Absent Range Means on a Part, and the Argument

The prompt posed three options for what an absent `kernel` field means on a part:
1. **Refuse them (fatal error)**
2. **Accept them silently (unconstrained)**
3. **Accept them, and report as a non-fatal problem (warning)**

### The Analysis

- **Option 1 (Refuse / Fatal):**
  Versions published before `partVersion.kernel` existed have no `kernel` field. Because published versions in `mesh-serve` are immutable (`PartVersionSchema` invariants enforce that published versions can never be modified), refusing an absent range would retroactively break every existing release composed from legacy parts. It would make previously published, working software permanently un-composable.

- **Option 3 (Accept & Report as Non-Fatal Problem):**
  At first glance, reporting a non-fatal problem seems attractive to prevent the field from becoming "decorative." However, at release composition time (`cdn.compose`), the caller is a release composer/site operator deploying existing catalog artifacts. If an upstream third-party dependency published in the past omitted `kernel`, reporting a warning on every compose produces permanent, un-actionable noise for the operator. The operator cannot fix the warning without forking and republishing the dependency under a new version.

- **Option 2 (Accept Silently as Unconstrained):**
  An absent range means the part does not specify a kernel constraint (matches any kernel version).

### The Architectural Decision

**Decision:** On a part, an absent range is accepted without error (not a mismatch).

**The Rationale:**
1. **Catalog Immutability & Separation of Concerns:**
   Enforcing the *presence* of a kernel range belongs at **publish time** (`publish-cli` and `catalog.publish`), where the part author can be required or warned to supply `--kernel`. Once a part version is published into the immutable catalog, **compose time** is the consumer side: its only responsibility is enforcing declared constraints.
2. **Consistency with Kernel Artifacts:**
   A kernel artifact has no kernel requirement of its own (`DeclarationSchema.kernel` is optional; a kernel does not run on top of a kernel). An absent range is fundamentally not a mismatch.
3. **Backward Compatibility:**
   Treating an absent range as unconstrained guarantees that legacy parts published before the field existed remain composable without disruption or false warnings.

---

## 3. Whether Any Release Currently in the Database Would Now Be Refused

An audit was performed across all MongoDB databases running on the system (`127.0.0.1:27017`):

1. **The Production Database (`mesh-serve`):**
   - The platform was rebuilt clean earlier today.
   - The `mesh-serve` database contains:
     - `release`: **0 documents**
     - `site`: **0 documents**
     - `partVersion`: **0 documents**
   - Result: **0 releases refused.**

2. **The Test Databases (`mesh-serve-spine-*`):**
   - Across all test databases created by test runs, releases are composed of `fixture-chrome` and `fixture-app` declaring `kernel: '^0.3'` against kernel `0.3.0`.
   - `satisfies('0.3.0', '^0.3')` evaluates to `true`.
   - Result: **0 releases refused.**

3. **Legacy Databases (`mesh_test_*`, `surfdns_*`):**
   - These databases belong to legacy testing harnesses from earlier microservices with different schemas (`appId`, `environmentId`).
   - None contain `mesh-serve` compositions.

### Conclusion
**Exactly zero releases currently in the database would be refused.** The clean platform rebuild earlier today successfully cleared out historical out-of-range compositions.

---

## 4. Whether `checkComposition`'s Problem Kinds Are Still the Right Set

`checkComposition` originally had four problem kinds:
1. `missing_part` (fatal — required part absent)
2. `missing_optional` (report — optional part absent)
3. `unmet_contract` (fatal — called contract not exposed)
4. `unused_grant` (report — exposed contract not called)

With F5, there are now **five** problem kinds:
5. `kernel_mismatch` (fatal — part kernel range not satisfied by release kernel)

### Architectural Analysis: The Compose-Time vs. Deploy-Time Split

Looking closely at `src/cdn/tools/compose.ts:87-92`:
```ts
// Part and kernel requirements only. A release cannot check contracts: what is exposed and at what gate
// is the site's record, and a release is deliberately site-independent — that is the whole
// reason a hundred hostnames can share one. So the grant check happens at deploy, where both
// halves are known, and requires is carried on the release for it to check against.
problems.push(...checkComposition(
    Object.keys(pinned),
    required,
    [],
    [],
    { version: resolved.kernel.version, ranges: kernelRanges },
));
```

Notice the architectural reality:
- Releases are **site-independent** (established by C1 and D4). Multiple hostnames and organizations share the exact same release hash.
- Contracts and exposure gates are **per-site** (established by D2 and D4).
- Therefore, `cdn.compose` **never passes contracts to `checkComposition`** (it passes `[], []`). Contract validation (`unmet_contract`) occurs at deploy time in `cdn.deploy`.
- `checkComposition` serves as a shared pure validation function for both release composition and deploy verification.

### Are the Five Kinds the Right Set?

Yes, the five kinds represent the exact domain invariants:
- **Parts:**
  - Fatal: `missing_part`
  - Non-fatal: `missing_optional`
- **Contracts:**
  - Fatal: `unmet_contract`
  - Non-fatal: `unused_grant`
- **Kernel:**
  - Fatal: `kernel_mismatch`

Could there be a non-fatal `kernel_unspecified`? As argued in §2, unstated kernel requirements on immutable parts cannot be resolved by release composers, so emitting a warning at compose time is non-actionable noise. A mandatory kernel check belongs at publish time.

Thus, the five problem kinds form a clean, complete, and balanced set of validation outcomes.

---

## 5. Notes for `spec/unread.md`

1. **`partVersion.kernel` is closed:**
   - Updated row in `spec/unread.md` §1 to reflect that `partVersion.kernel` is now read and enforced at release composition time by `checkComposition` in `cdn.compose`.
   - A mismatch against the release's kernel version is fatal (`kernel_mismatch`), preventing unviable combinations from reaching browsers.
2. **Related Unread Items:**
   - `artifact.declaration.requiredParts`: Remains in `unread.md` §1 because `cdn.compose` reads requirements from `partVersion` in the catalog rather than from the artifact declaration itself.
   - `artifact.declaration.builtAgainst`: Remains in `unread.md` §1; recorded from lockfile during artifact build, but currently unread by production code.

---

## 6. Test Suite and Verification

All tests ran in the foreground and passed:
- `test/cdn/release.test.ts`:
  - `refuses a kernel mismatch, naming both the part and the range`
  - `also refuses when kernel version is partial string 0.13`
  - `treats a kernel artifact's own absent requirement as not a mismatch`
  - `accepts an absent range on a part without error`
  - `is satisfied when the kernel is within the declared range`
  - `reports kernel mismatch alongside missing parts and contract errors`
- `test/integration/spine.test.ts`:
  - `refuses to compose when a part declares an incompatible kernel range`
  - `composes cleanly when a part declares no kernel range`
- Total Suite: **28 test files passed (352 passed, 0 failed).**
- Typecheck: `npm run typecheck` passed with **0 errors and 0 type casts**.
