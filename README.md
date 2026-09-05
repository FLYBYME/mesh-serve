# mesh-serve

The serving half of the platform, as mesh ServiceModules: **build a repository into
content-addressed artifacts, and serve them by hostname.**

Empty on purpose. Written from nothing rather than ported — the code it replaces lived in
`mesh-web/server/`, which was a browser framework repository that had grown a builder, a CDN and a
protocol package, and every question about that repository had become ambiguous because the container
held two products.

Modelled on `mesh-identity`, which is the ServiceModule shape to copy: one package, `src/contracts`,
`src/schema`, `src/methods`, a `module.ts`, a `store.ts`, and tests that run with no cluster.

## What lives here

Four ServiceModules that ship together, which is the test that decides what shares a repository —
not whether they are conceptually similar.

- **`builder`** — fetch a source reference into a workspace it owns and destroys, run the
  repository's own build, collect the output into a content-addressed artifact, publish it.
- **`cdn`** — hostname → what it serves. Small, stateless, many, everywhere.
- **`api`** — binds a port and turns exposed contracts into REST, SSE and WebSockets. A listener and
  a cache: across requests it holds the exposure map and the ticket cache, and nothing else.
- **`identity`** — users, organizations, roles as records, opaque tickets.
- **`catalog`** — what parts and kernels exist, at which versions and hashes, and what each is
  compatible with. Named `catalog` rather than `store`, which means persistence in every service
  here, or `registry`, which is already the mesh's node registry.

All are ordinary ServiceModules: contracts and tools on a broker. Some bind a port.

## What a build is

**No install.** A part's repository is bundled exactly as it arrives: fetch the commit, run esbuild,
hash the output. No `npm i`, no network, no `node_modules`. This is possible because **esbuild does
not typecheck** — it strips types and emits — so a part whose only dependency is the framework needs
nothing installed at all.

Two rules make it hold:

- **The framework is `external`.** It is never bundled into a part; the page's import map resolves it
  to the one mounted kernel artifact. `mesh-ui` got this wrong in the one line that mattered — its
  `external` list named node builtins and server packages, and aliased `@flybyme/mesh` to a browser
  build that esbuild then **inlined into every extension**. That is one kernel per part, which is one
  of every singleton per part.
- **Everything else is vendored.** A part that uses a third-party library commits it. There is no
  resolution step, so a missing dependency is a build failure rather than a network round trip.

Typechecking is the author's job, in their own repository, before they push. A build server is the
slowest place to discover that a type is wrong.

## What the CDN generates

A site's page is not written by anyone. The CDN composes it from the catalog — a compatible kernel
and a set of parts — and emits:

- **`index.html`** — the shell, with the import map pointing at the mounted kernel
- **the boot module** — which parts to load and in what order, from the composition
- **the theme** — token *values*, which come from the composition rather than from any bundle

It links what the kernel and the parts already carry: the kernel ships the CSS rules, and esbuild
emits a part's own stylesheet beside its module.

**Generated when the composition changes, not per request.** The output is hashed and stored like any
other artifact, or it becomes the one thing in the system that is not content-addressed and needs its
caching special-cased.

The CDN is also where **policy** is enforced, which is why policy belongs to a composition rather than
to a build: changing it should not mean rebuilding a part that did not change.

## Layout

```
src/
  schema/               shapes more than one service needs — Artifact, Site, SourceRef
  <service>/
    contracts/          the domain's contracts. One definition serves RPC, REST and CLI.
    schema/             that service's own zod shapes
    methods/            pure functions
    module.ts           the ServiceModule
    store.ts            persistence, where a service has any
```

**`methods/` is the purity rule and it is worth enforcing rather than describing.** Nothing there may
import a broker, a database, or node I/O. It is what keeps the part of a service that can be reasoned
about separable from the part that touches the world — and paas found, at 88,000 lines, that a
convention nobody checks is not a boundary.

## What does not live here

**The browser runtime.** That is `mesh-web`, and it is a dependency of the *sites* this serves, never
of this. Nothing in `src/` may import it.

**Client generation.** `emitClient` reads an exposure list with no cluster running, which is what lets
a site's typed client be produced at build time. It belongs where a build can reach it without
installing a web server — see the note on packaging below.

## Decisions this repository starts from

Carried over rather than rediscovered:

- **A site composes several artifacts, not one.** A hostname mounts a shared kernel and the parts
  that make up the page. Before this, a site served exactly one artifact, so every site carried a
  private copy of the framework — 94% of a real artifact's bytes.
- **An artifact declares what it provides and what it was built against.** Recorded by the build,
  from the built tree, and for a git dependency that means the **commit** — a package consumed from a
  branch keeps its author's version forever, so the version alone identifies nothing.
- **The descriptor is build input.** `mesh.json` is read from a commit with no cluster running. What
  a person edits afterwards is a different thing and belongs in a different file.

## One package for now, and where it will split

Started as a single package because four modules that boot together are easier to keep honest that
way, and because splitting on a guess is how `mesh-web/server` ended up with three packages and one
of them empty of anything a consumer wanted.

The split that is already visible: **the exposure vocabulary and the client generator run at build
time, and everything else runs at runtime.** A UI-only repository needs `ExposeEntry`,
`describeExposure` and `emitClient` to produce its client, and needs no port, no express and no
broker. Today installing them means installing a web server. When that starts to hurt, the line is
there and it is not arbitrary.
