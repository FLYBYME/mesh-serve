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

mesh is frozen (`mesh/docs/STABILITY.md`), and adding registry fields for a downstream package is
explicitly disallowed. So the four things below are **mesh-serve's**, in a `defineCollection` that
wraps `defineCrud` and enforces the rest in this package's own serving layer.

### Hidden fields

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

- **Whether `defineCollection` wraps or replaces.** Wrapping keeps mesh frozen and costs two
  definition functions that can drift. The alternative is unfreezing mesh while three packages are
  built on it concurrently. Wrapping is the current decision.
- **Whether asking for a hidden field is a refusal or a silent drop.** Recorded above as a refusal;
  not yet built.
- **One name for the scope field.** `tenantId` and `organizationId` are the same value under two
  names because two schemas disagreed.
