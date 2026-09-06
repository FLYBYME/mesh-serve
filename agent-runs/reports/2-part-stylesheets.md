# Part Stylesheets Report: Roadmap M2/C8

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-2`  
**Branch:** `dispatch/2`  
**Issues addressed:** Part CSS delivery, Canonical stylesheet ordering, Roadmap M2/C8 (Scoping Decision).

---

## 1. Which of the Four Steps Already Worked, and Which Had to Be Built

Before building anything, each stage of the pipeline was audited:

1. **`src/builder/methods/bundle.ts` — ALREADY WORKED:**  
   `bundlePart` invokes esbuild with `bundle: true`, `entryNames: 'index'`, and loops over `result.outputFiles`. When an entry imports a stylesheet (e.g. `import './style.css'`), esbuild generates `index.css` alongside `index.js`. `bundlePart` calculates each file's digest, maps its content type, records it in `files`, and stores its buffer in `blobs`. Verified with direct invocation: an application importing a `.css` file produces both `index.js` and `index.css` in its artifact.

2. **`src/builder/methods/content.ts` — ALREADY WORKED:**  
   `contentTypeOf` already maps `.css` to `'text/css; charset=utf-8'`.

3. **`src/cdn/methods/page.ts` — HAD TO BE BUILT (Part stylesheets):**  
   Previously, `page.ts` only accepted `kernel.styles` and emitted `<link>` tags exclusively for the kernel's stylesheets. It had no concept of part stylesheets.  
   **Built:** Extended `PageInput` with optional `partStyles?: Readonly<Record<string, readonly string[]>>`, mapping part IDs to their respective stylesheet paths. In `indexHtml`, part stylesheets are emitted after kernel stylesheets in canonical part composition order (sorted by part ID), with paths within each part sorted deterministically. When a part ships no stylesheets (or is omitted), nothing is emitted for it, and the document output remains byte-identical.

4. **`src/cdn/cdn.service.ts` — HAD TO BE BUILT (Part stylesheet collection):**  
   Previously, `pageFile` only loaded the kernel artifact (`await this.artifactFor(release.kernel.digest)`) and filtered `kernel.files` for `.css`. It never retrieved part artifacts for styling.  
   **Built:** `pageFile` now fetches all part artifacts in parallel (`Promise.all`), filters each part's files for `.css`, sorts them, and passes the resulting `partStyles` map into `generatePage`. If any required artifact is missing from the node, `pageFile` returns `undefined` (resulting in a 404), exactly consistent with the kernel artifact check.

---

## 2. The Scoping Decision and the Argument For It (Roadmap M2/C8)

### The Problem
When two parts on one page both define a common selector (such as `.card`, `.panel`, or `.header`), they share the document stylesheet context. Roadmap M2/C8 identified this open architectural question.

### The Alternatives Evaluated

1. **A digest-derived attribute on markup and rewritten CSS (Rejected):**  
   Rewriting selectors and DOM elements with hash attributes (e.g., `[data-mesh-part="..."]`) has severe drawbacks:
   - **Breaks content addressing:** The artifact's bytes would depend on its mount context or compile-time hash transformations, violating the core rule that an artifact must be byte-identical on every site that runs it.
   - **Requires a CSS-in-JS or preprocessor runtime:** Bypasses standard browser esbuild bundling and introduces heavy build/runtime toolchains, violating the core architectural constraint (*"Do not build a CSS-in-JS layer, a theme compiler, or a preprocessor"*).
   - **Breaks shared component rendering:** Parts often render into shared containers provided by the kernel (e.g., window frames, titlebars, taskbars, menus, modals). Synthetic attribute scoping prevents a part from seamlessly integrating into the kernel shell or styling slot containers.

2. **Compose-time selector collision detection (Rejected):**  
   `cdn.compose` is a fast, pure metadata operation over the catalog (`partVersion`), checking version ranges and contracts.
   - Requiring compose to fetch every part's artifact blobs across the network and parse their CSS ASTs would turn a millisecond catalog resolution into an expensive, I/O-heavy pipeline.
   - More importantly, parts *deliberately* share classes: utility classes, shared layout tokens, and intentional overrides of kernel rules (such as restyling `.window`). Reporting or refusing collisions on shared selectors would create false positives and break legitimate styling extensions.

3. **Document-level cascade with canonical ordering (Chosen):**  
   The platform adopts the standard Web platform model:
   - **Pure content addressing:** Artifacts remain pure esbuild bundles, completely unchanged whether loaded standalone or alongside 50 other parts.
   - **Deterministic tie-breaking:** Order in CSS is canonical. The kernel stylesheet is linked first, followed by parts in canonical composition order (alphabetical by part ID), followed by `:root` custom properties.
   - **Seamless token inheritance:** Site themes are defined as CSS custom properties on `:root`. Under a shared document cascade, tokens inherit naturally across all parts without requiring Shadow DOM pierce mechanisms or build-time scoping hacks.
   - **Conventional scoping in userland:** Authors who desire component isolation use standard BEM or namespace prefixes (e.g., `.chrome-panel`). This is standard across the Web ecosystem without platform-imposed overhead.

---

## 3. What Happens Today When Two Parts Define the Same Selector, and What We Decided Should Happen

### Before this change
Because parts could not ship stylesheets, authors had to style everything via inline `style="..."` attributes (as documented in `mesh-core/src/chrome/index.ts`).
Inline styles have specificity `1,0,0,0`, cannot be targeted by media queries or pseudo-classes, collide invisibly, and cannot be overridden by `:root` theme tokens or user styles. When layouts broke, debugging was notoriously difficult.

### What happens now
Parts author plain `.css` files imported into their entry points.
1. The kernel stylesheet is linked first.
2. Part stylesheets are linked in canonical composition order (sorted by part ID).
3. If Part A (`fixture-app`) and Part B (`fixture-chrome`) both define `.card`:
   - Specificity determines the winner first (standard CSS rule).
   - If specificity is equal, source order breaks the tie: `fixture-chrome` (later in composition order) overrides `fixture-app`.
4. If a part overrides a kernel rule like `.window`:
   - Because the kernel stylesheet is loaded first, the part's rule cleanly overrides the kernel default.
5. All parts inherit custom properties (`--surface`, `--ink`) defined on `:root` by the site record.

---

## 4. Findings for `spec/unread.md`

During close inspection of `src/builder/` and `src/cdn/`, three fields were identified that are written or parsed but never read by production code:

1. **`artifact.declaration.builtAgainst` (and `ResolvedDependency.commit`)** (`src/builder/schema/artifact.ts`):
   - Comment promises: *"A dependency at the version that was actually linked, not the one that was asked for… the point of this record is to be a fact something else can compare against."*
   - Reality: Parsed from lockfiles in `build_start.ts` and stored on every artifact declaration in `publish.ts`. Never read anywhere in `src/`.
2. **`artifact.declaration.requiredParts`** (`src/builder/schema/artifact.ts`):
   - Comment promises: *"A node holding the bytes can answer what does this need without a catalog lookup."*
   - Reality: Stored on the artifact declaration; `cdn.compose` reads requirements from `partVersion.requiredParts` in the catalog instead.
3. **`release.exposure`** (`src/cdn/schema/release.ts`):
   - Comment promises: *"Recorded here so a mismatch is an error at compose time rather than a confusing 404 three calls later."*
   - Reality: `cdn_compose` never writes or checks it, and nothing in `src/` ever reads it. Roadmap **D5c**.

All three have been documented in `spec/unread.md`.

---

## 5. Verification Summary

- **Typecheck:** `npm run typecheck` clean with **zero casts**.
- **Unit Tests (`test/cdn/page.test.ts`):** 25/25 passing, verifying kernel and part stylesheet ordering and asserting that parts without stylesheets change nothing about the generated page.
- **Integration Test (`test/integration/spine.test.ts`):** 16/16 passing against real MongoDB, real esbuild, and a real HTTP server:
  - Published a kernel and two parts (`fixture-chrome` with stylesheet, `fixture-app` with no stylesheet).
  - Built each into content-addressed artifacts.
  - Composed and deployed a release.
  - Asserted the served page contains `<link>` tags for both the kernel and part stylesheets in that exact order.
  - Asserted that `fixture-app` (no stylesheet) emitted no link.
  - Fetched both `.css` files over HTTP, verifying `200 OK`, `text/css; charset=utf-8`, and `immutable` caching.
  - Verified a release with only a stylesheet-less part changes nothing about the page.
- **Full Test Suite:** 20 test files, 278 passed (increased from baseline 275).
