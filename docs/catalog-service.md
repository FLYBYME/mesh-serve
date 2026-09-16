# Catalog Service & Build Engine

The [`CatalogService`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L17) (`serve.catalog`) manages the source code, compilation, artifact generation, and release packaging pipeline for web applications.

---

## Domain Model & Schemas

The service manages five core database entities under the `serve` namespace:

### 1. [`Repo`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/repo.contract.js) (`serve.repo`)
Represents a source control repository:
* `tenantId`: Organization that owns the repository.
* `url`: Git remote URL (supports HTTPS, SSH, or local bare mirror paths).
* `defaultBranch`: Fallback branch (e.g. `master`, `main`).

### 2. [`Part`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/part.contract.js) (`serve.part`)
A buildable component within a repository:
* `key`: Unique identifier in the format `<org-slug>/<part-name>` (enforced by [`validatePartKey`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L66) on creation and update).
* `kind`: Component type:
  * `kernel`: The core boot runtime bundle (`@flybyme/mesh-web`).
  * `application`: Top-level application registered with the kernel.
  * `extension`: Plug-in contribution registered with the kernel.
  * `driver`: Kernel-level capability baked into the kernel bundle.
  * `theme`: CSS stylesheet bundle supplying default styles.
* `path`: Directory within the repository containing the part (`.` for root).
* `entryPoint`: Relative entry file path (e.g. `src/index.ts`).
* `imports`: Optional bare specifier (e.g. `@flybyme/mesh-core/ui`) by which sibling parts import this component.
* `wants`: Array of contract keys called by this part (e.g. `["identity.whoami", "serve.cdn.find"]`), extracted automatically from `mesh.wants.json` at build time.

### 3. [`Artifact`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/artifact.contract.js) (`serve.artifact`)
An immutable compiled output from a part at a specific git ref:
* `partId`: Reference to the parent part.
* `ref`: Git commit SHA, branch, or tag built.
* `drivers`: When building a kernel part, the exact list of driver keys baked into the bundle.
* `status`: Build lifecycle state (`pending`, `running`, `success`, `failed`).
* `hash`: Content-addressed SHA-256 hash of all output files.
* `assets`: Manifest of files produced by the build (URLs, names, extensions, and SRI digests).
* `duration`: Build execution time in seconds.
* `error`: Failure message if compilation failed.

### 4. [`Composition`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/composition.contract.js) (`serve.composition`)
A blueprint combining parts into a deployable package:
* `key`: Identifier matching the primary `application` part key.
* `kernelPartKey`: Key of the kernel part to boot.
* `drivers`: List of driver part keys baked into this composition's kernel.
* `theme`: Optional theme part key.
* `parts`: List of application and extension part keys included.

### 5. [`Release`](file:///home/ubuntu/code/mesh-serve/src/catalog/contracts/release.contract.js) (`serve.release`)
An immutable, pinned snapshot of a composition pointing to concrete artifact hashes:
* `compositionId`: Reference to the source composition.
* `hash`: Deterministic SHA-256 hash derived from the sorted part-to-artifact mapping.
* `parts`: Array of release part entries containing `partKey`, `kind`, `artifactHash`, and `imports`.

---

## The Build Pipeline

Compilation is orchestrated in [`build.ts`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts):

### Standard Part Build ([`buildPart`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L150))
1. **Repository Checkout**: Clones or fetches the repository into a local cache directory using [`ensureRepoCheckout`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L19).
2. **External Specifier Resolution**: Resolves all `imports` specifiers declared by other parts in the same organization via [`resolveExternals`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L139). These specifiers are marked `external` in `esbuild` so that code is not bundled twice when loaded together in a browser import map.
3. **Contract Dependency Extraction**: Reads `mesh.wants.json` sibling to the entry point.
4. **Compilation**: Invokes `esbuild` targeting `browser`, `esm`, `es2020`, with minification and source maps enabled.
5. **Content Hashing & Storage**:
   * Walks the temporary build directory in alphabetical order.
   * Feeds relative paths and file buffers into a SHA-256 hasher.
   * Generates Subresource Integrity (SRI) digests (`sha384-...`) for every asset.
   * Atomically copies files into `~/.mesh/artifacts/<hash>/`.

### Kernel Build ([`buildKernel`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L174))
A kernel is compiled into a single unified bundle that joins the kernel runtime and all configured drivers into one module graph:
1. Resolves driver parts and their repositories via [`resolveDrivers`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L114).
2. Synthesizes a virtual entry point that:
   * Imports and re-exports everything from the kernel entry: `export * from '${kernelEntry}';`
   * Imports each driver's default export: `import driver_0 from '${driverPath}';`
   * Exports the unified driver array: `export const drivers = [driver_0, ...];`
3. Runs `esbuild` on the synthesized entry to produce a single browser bundle.

---

## Composition & Release Creation

The [`compose`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/compose.ts#L62) tool generates a release:

1. **Part Resolution**: Verifies that every part specified in the composition exists and matches its expected kind.
2. **Artifact Matching**: Queries `serve.artifact` for the most recent artifact with `status: 'success'` for each part.
   * For the kernel, it matches the artifact that contains the composition's exact driver set using [`sameDrivers`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/compose.ts#L10).
3. **Release Hash Calculation**:
   ```ts
   const hash = crypto.createHash('sha256')
       .update(JSON.stringify({ compositionId: composition.id, parts: releaseParts }))
       .digest('hex');
   ```
4. **Idempotent Persistence**: If a release with this hash already exists, it is returned immediately; otherwise, a new `serve.release` is stored.

---

## Background Worker: `watchRelease`

When [`CatalogService.onStart`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L83) initializes, it registers an interval timer running [`watchRelease`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L105) every 60 seconds:
* Queries the database across all tenants for artifacts with `status: 'pending'`.
* Transitions each artifact to `status: 'running'`.
* Executes [`buildKernel`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L174) or [`buildPart`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L150).
* On success, updates the artifact to `status: 'success'`, saves `hash` and `assets`, updates `part.wants`, and emits the `serve.artifact.built` event.
* On error, marks the artifact as `status: 'failed'` and emits `serve.artifact.buildFailed`.

---

## Artifact Asset Serving

Assets are read from disk via [`getAsset`](file:///home/ubuntu/code/mesh-serve/src/catalog/tools/getAsset.ts#L12) and [`artifactAssetPath`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/artifacts.ts#L36):
* **Path Traversal Protection**: Enforces that resolved absolute paths remain strictly within `~/.mesh/artifacts/<hash>/`.
* **Metadata**: Computes MIME content types via file extension, content length, file modification time, and an ETag hash:
  ```ts
  eTag: `"${crypto.createHash('sha1').update(`${artifactHash}:${path}:${mtimeMs}:${size}`).digest('hex')}"`
  ```
