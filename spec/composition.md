# Composition

What a site is, and where that is written down.

**Status: Decided in shape, Open in detail.** The record exists as
`src/cdn/schema/site.ts` with tests; the resolver that fills in its `resolution` does not.

---

## 1. A site is a hostname — **Decided**

Not a repository, and this is the correction that unlocked everything else.

`surfdns-console` spent a week being a repository that was trying to be a site: it carried an
`index.html`, a `main.ts`, a `site.mjs` assembler and a service half, and each of those existed to
compensate for something no one owned. Strip them and what is left is one application — which is a
*part*, not a site.

**A site is a record.** Repositories hold parts. The record says: this hostname is this kernel plus
these parts at these versions, exposing these contracts behind these gates.

## 2. `mesh.json` after it stops being a file — **Decided**

The file was always a sketch of the record. Three things change on the way across, and each one
removes a problem rather than moving it.

**`environments` disappears.** A site *is* a hostname, so `production` and `local` were never two
environments of one thing — they are two sites. `host` and `api` become fields; `application` becomes
a grouping label rather than an identity.

> The consequence worth noticing: **a part is no longer built per environment.** The old descriptor
> baked `MESH_API` into the bundle, so one source produced a different artifact for production than
> for local. With `api` a property of the site, one artifact serves every site that chooses it. That
> is most of why a part can be versioned at all.

**Contracts are named, not imported.** `ExposeEntry` held a live `ToolContract`, which is why an
exposure list had to be TypeScript, and why a UI repository had to ship a service half in order to
have one. `"domains.zone_create"` is a name, and a name is ordinary data. See
[exposure.md](./exposure.md) for what is lost and how it is recovered.

**Desired and resolved are separate fields.** `parts[].version` is what a person asked for — `^1.4`,
or `*`. `resolution` is what was actually composed, by digest, written by the cdn. Collapsing them
makes *what is this site actually running* unanswerable, which is the exact failure the previous
generation is being replaced for.

## 3. Requirements and grants — **Decided**

A part declares what it *calls*. A site declares what it *exposes*, and at what gate. They look alike
and must not be merged.

| | says | written by |
| --- | --- | --- |
| a part's own descriptor | *I call `domains.zone_create`* | the part's author — a **requirement** |
| the site record's `mesh[]` | *I expose `domains.zone_create` at `auth: user`* | the site's owner — a **grant** |

**A part must never choose its own gate.** If a part could declare `domains.zone_delete: public`,
then installing a part would be a privilege escalation with nobody in the loop.

Composing is checking one list against the other:

- a requirement with no grant → **refuse**, naming the part and the contract it wanted
- a grant with no requirement → **report**; that is the route nobody deleted

This is `needs()` / `provides()` one level up. A part declares what it needs, the site grants it, and
the thing that assembles them refuses when a need is unmet.

## 4. Every part carries its own descriptor — **Decided**

`{ kind, id, version, kernel, mesh: [{ package, version, contracts: ["…"] }] }` — keys only, no
gates.

A part is then self-contained: install it into any site and it says what it needs. An extension that
talks to nothing declares nothing. A site's total requirement is the union of its parts', which means
adding a part cannot silently leave a hole.

## 5. What the record holds

`src/cdn/schema/site.ts`. The parts worth reading twice:

**The gate is a strict union.** `auth` or `permission`, and `.strict()` on both branches, so an entry
with **neither** and an entry with **both** are equally unrepresentable. Without `.strict()`, zod
strips the unknown key and silently matches whichever branch was declared first — an author who wrote
both would get one of them, chosen by declaration order, with nothing said. Verified by removing it
and watching the test fail.

**`idField: 'host'`.** A site is a hostname and it is looked up on every request; an invented id would
need a secondary index to answer the only question this collection is ever asked.

**`dependencies: []`.** Required by `defineCrud`, and an empty array is an answer here rather than a
default: reading and writing a site record touches no other domain. The things that *do* have
dependencies — resolving parts against the catalog, checking `tenantId` is a real organization — are
explicit contracts, because CRUD is used idiomatically and never hooked.

## 6. Open

- **Version ranges or exact pins.** `version: ""` in the sketch. `1.4.2` is safe and means every
  kernel patch breaks every part; `^1.4` needs a resolver and honest semver from the kernel, which it
  does not have yet — `@flybyme/mesh-web` reports `0.1.0` on every build forever because it is
  consumed from a branch.
- **The resolver.** Choosing a kernel and a set of parts that satisfy each other's ranges is a pure
  function: catalog contents in, resolved set out. It belongs in `catalog/methods/`, which makes the
  hardest logic in the system the most testable thing in it.
- **Where a theme comes from.** The record carries token values today. Whether a theme is also a
  publishable, versioned thing — a third kind of part, with no code — is undecided. It is the one
  case where "switch the styling" is the right verb.
