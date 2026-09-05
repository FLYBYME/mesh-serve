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

- **`builder`** — fetch a source reference into a workspace it owns and destroys, run the
  repository's own build, collect the output into a content-addressed artifact, publish it.
- **`cdn`** — hostname → what it serves. Small, stateless, many, everywhere.

Both are ordinary ServiceModules: contracts and tools on a broker, one of which binds a port.

## What does not live here

**The browser runtime.** That is `mesh-web`, and it is a dependency of the *sites* this serves, never
of this. Nothing in `src/` should import it.

**The HTTP surface for contracts.** `mesh-api` turns exposed contracts into REST and SSE. If these
modules are exposed over HTTP, they are exposed by that, the same as any other module.

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
