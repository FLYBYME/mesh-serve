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

Three of the four bind a port. All four are ordinary ServiceModules: contracts and tools on a broker.

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
