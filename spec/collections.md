# Collections

**How a collection is defined, and why `defineCrud` alone is not enough.**

Every noun in this platform is a collection: sites, releases, parts, repositories, organizations,
memberships, roles, grants, nodes. They are the thing [serving.md](./serving.md) projects and the
thing [identity.md](./identity.md) scopes. So how one is declared decides most of what the platform
can do.

## 1. What `defineCrud` already gives, and it is a lot

mesh's `defineCrud(domain, schema, options)` generates ten actions, their contracts, their input and
output schemas, their routes and their tool names. It already carries:

- **`scopedBy`** — the field a collection is narrowed by, so a generated find is always within the
  caller's resolved scope. This is what makes *never expose an unbounded find* enforceable rather
  than advisory.
- **`unique`** — declared keys, built as indexes.
- **per-action `visibility`, defaulting to `internal`.** A contract is not reachable because it
  exists; publishing one is a decision somebody writes down.
- **`limit`, `offset`, `sort`, `search`, `searchFields`, `fields`, `query`** on every find.

**That last line is worth repeating, because nothing in this platform uses it.** Pagination, sorting
and search are already in every generated contract. Every list in every UI fetches the whole
collection unsorted. That is not missing server work; it is parameters nobody passed.

## 2. What it does not give

**These belong in `defineCrud`, not in a wrapper, and an earlier draft of this file got that
backwards.**

`mesh/docs/STABILITY.md` says frozen, bug fixes only, and that is about mesh not drifting under three
packages being built on it concurrently. It is not the whole picture.
`surfdns/architecture/the-freeze.md` plans **mesh 2 → 3**, and says the thing that decides this:

> **The version bump is the last cheap breaking change.** Every interface mistake still in the
> surface on freeze day is permanent, or costs a major version to remove.

Its **Track V** is *"All three items are `defineCrud` semantics, all three are breaking"*, and **V2**
is field-level visibility, described there as *"the single strongest argument for v3 being a real
major rather than a renumbering"*.

So a `defineCollection` wrapper would be building a second definition function **during the one
window in which fixing the first is cheap**, and leaving the original wrong forever. The two would
disagree, and the disagreement would be about security.

What follows goes into `defineCrud` as part of 2 → 3. Where mesh-serve still needs its own layer —
routing, the projections, precedence — that is named as such below.

### Hidden fields — surfdns **V2**, and it is mesh's

A collection may hold something no caller may ever receive: a password hash, a token hash. Today the
only way to keep it in is to mark every action internal, which is why nothing can turn a user id
into a name.

**A hidden field must be enforced in two places, and the second is the one that was missing:**

1. **Absent from the output schema**, so a result is stripped on the way out.
2. **Refused in the projection**, so `fields: 'passwordHash'` cannot ask for it.

(1) alone was not a boundary. mesh skipped output parsing entirely whenever `fields` was present,
because a projected document is partial and would fail a schema with required fields — so asking for
a projection returned the raw document. **Fixed in mesh on 2026-09-11** as a defect: a projected read
is now parsed against a partial schema, so missing keys are allowed and undeclared keys are still
stripped.

(2) still belongs here. Asking for a hidden field is **an error naming it**, not a silent omission.
A caller who asks has either made a mistake or made an attempt, and both deserve an answer rather
than an empty column.

### Two kinds of collection, and publishing crosses between them

`scopedBy` has one answer: a row is in your organization or you cannot see it. That is right, and it
is not enough, because some things are meant to be shared — `serve/kernel` is **owned by one
organization and usable by everyone**.

**The answer is not a flag on the row.** A per-row `visibility` field turns every scoped read into a
union, makes every write check whether it is crossing a line, and puts the most security-sensitive
decision in the platform inside a column that an update could change by accident.

**A collection is either scoped or public, declared once:**

| | scoped | public |
| --- | --- | --- |
| read | within the caller's organization | by anyone, including no caller |
| write | permission, within the scope | permission, and only the owning organization |
| carries | `organizationId` | an owner field, for writes |
| examples | repository, site, membership, card | part, version, a blog post |

**Publishing is a contract, not a field change.** It reads from a scoped collection and writes to a
public one, and it is the only thing that crosses. So it has a name, a permission, an audit trail,
and somewhere to put the rules — *is this version already published, does this name belong to you,
is the digest reproducible*. A boolean has nowhere to put any of that.

Three consequences:

- **A public collection may be a different shape.** It holds what publishing chose to expose, which
  is usually narrower than the private row. A repository has a URL and a default branch; the part it
  publishes does not.
- **An unscoped read is unbounded, which this platform bans**, so on a public collection pagination
  is not optional — a default limit and a maximum, enforced, not left to the caller. That is
  surfdns **V1** and **V4** and this is the case that needs them most.
- **Scoped stays exactly as it is.** No union, no per-row check, and `scopedBy` does not have to
  change for mesh 2 → 3. One fewer breaking change in the window.

The unresolved part is not the mechanism, it is **what a public collection's writes are gated by**.
Reads are open by construction; creates and updates still belong to an owner, and the owner field is
doing work that `scopedBy` used to do for free.

### Nested routes

`defineCrud` generates `/{plural}` and `/{plural}/:id` from a `pluralPath` and nothing else. A
collection owned by another collection has no way to say so.

```
/organizations/:organizationId/repositories/:repositoryId/parts/:id
```

The `:organizationId` segment is **an assertion to verify**, never an input — see
[identity.md](./identity.md) §3. It earns its place because a URL that names the organization is one
you can paste, log and reason about, and because a mismatch between it and the resolved scope is a
refusal rather than a silent read of the wrong thing.

`:repositoryId` is different in kind: a genuine parent, not a scope. A part without its repository is
meaningless.

**And this is what fixes the part namespace.** Today a part name is one global namespace, so a second
organization importing `mesh-web` is refused outright — there is a whole error message about it.
Under a nested identity a part is `platform/kernel` and `flowboard/kernel` coexist. The constraint
stops existing rather than getting a better message.

### Relations

`defineCrud` accepts `relations` and a `populate` query parameter, and **nothing in mesh reads
either.** They appear in exactly one file, where they are stored on a registry and never consumed.
Declared surface with nothing behind it.

So relations are mesh-serve's to implement, or to delete from the vocabulary. Implementing them is
what makes a nested route answerable without the caller making two round trips.

### Route, query, body precedence

One field can arrive three ways. **Route wins, then query, then body** — because the route value is
the one that was verified. A body that disagrees with a verified route is an error, not a value to
discard quietly.

## 3. What must be true

- **Absent means internal.** Inherited from `defineCrud` and never relaxed.
- **A hidden field is hidden in both directions.** Output and projection.
- **A scoped collection is narrowed by the resolved scope, never by a value from the request.**
- **A collection that cannot be read without a scope cannot be on the serving path**, because a
  browser fetching a page is anonymous by definition.
- **One definition function.** The reason to wrap `defineCrud` rather than reach past it is that two
  ways to declare a collection will disagree, and the disagreement will be about security.

## 4. Open

See [questions.md](./questions.md) — the open items from every spec are gathered there, so there is
one list to work through rather than five.
