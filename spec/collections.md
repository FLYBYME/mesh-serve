# Collections

**How a collection is declared, and what `defineCrud` still lacks.**

Every noun on this platform is a collection: sites, releases, parts, repositories, organizations,
memberships, roles, grants, nodes. They are the thing [serving.md](./serving.md) projects and the
thing [identity.md](./identity.md) scopes. **So how one is declared decides most of what the platform
can do**, and the gaps below are not conveniences — each one has produced a hand-written workaround
that exists five times.

**§1 describes mesh, which exists.** Everything else here describes mesh-serve, which does not: where
this document says *today*, it is describing `src-dump/`, the deleted implementation.

---

## 1. What `defineCrud` generates

`defineCrud(domain, schema, options)` produces ten contracts, their input and output schemas, their
routes and their tool names.

| action | input | output |
| --- | --- | --- |
| `find` | the query params below | `Row[]` |
| `findOne` | the query params below | `Row \| undefined` |
| `count` | `search`, `searchFields`, `query` | `number` |
| `get` | id, `fields`, `populate` | `Row` — throws if absent |
| `resolve` | id, `fields`, `populate` | `Row \| undefined` — the same lookup, never throws |
| `create` | the row, minus generated fields | `Row` |
| `createMany` | an array of those | `Row[]` |
| `update` | id and a partial row | `Row` |
| `replace` | id and a whole row | `Row` |
| `delete` | id | `{ success: boolean }` |

**`get` and `resolve` are the same lookup and differ only in how absence is reported.** That pairing
is worth copying: a caller who knows the row exists gets an exception, a caller who is asking gets
`undefined`, and neither has to catch to find out.

### Every find already takes these

```ts
limit: number = 100      offset: number = 0
sort: string | string[]  // '-' prefix descends
search: string           searchFields: string | string[]
query: Record<string, unknown>
fields: string | string[]     // projection
populate: string | string[]   // declared, consumed nowhere — §5
```

**Nothing in this platform has ever passed one of them.** Pagination, sorting and search are in all
174 contracts already. Every list in every UI fetched the whole collection, unsorted. **That is not
missing server work; it is parameters nobody passed**, and it is why **A3** is a question about
defaults rather than about features.

### The options

```ts
{
    pluralPath: 'sites',
    idField: 'id',
    scopedBy: 'organizationId',
    unique: [{ fields: 'host', scope: 'global' }],
    visibility: { find: 'public', create: 'internal', ... },
    dependencies: ['identity.whoami'],
    relations: [...],          // consumed nowhere — §5
    delivery: 'global',
}
```

**`scopedBy` is what makes *never expose an unbounded find* enforceable rather than advisory.** A
generated find on a scoped collection is always within the caller's resolved scope, in mesh's database
middleware, below anything a handler can forget.

**`unique` must declare its scope on a scoped collection, and `defineCrud` throws if it does not:**

> Collection "site" is scoped by "tenantId". Unique key "host" must explicitly declare
> `scope: 'scoped'` or `scope: 'global'` so its tenant isolation boundary is explicit.

That refusal is the right shape for everything in this document. **A default would have been silently
wrong half the time**, and which half depends on the collection.

**`visibility` defaults every action to `internal`.** A contract is not reachable because it exists.

---

## 2. What must be true

- **Absent means internal.** Inherited from `defineCrud` and never relaxed.
- **A scoped collection is narrowed by the resolved scope, never by a value from the request.**
- **A hidden field is hidden in both directions** — output and projection. §3.
- **A collection that cannot be read without a scope cannot be on the serving path**, because a
  browser fetching a page is anonymous by definition.
- **One definition function.** Two ways to declare a collection will disagree, and the disagreement
  will be about security.

---

## 3. What belongs in `defineCrud` and is not there

**These go into mesh 2 → 3, not into a wrapper, and an earlier draft of this file got that
backwards.**

`mesh/docs/STABILITY.md` says frozen, bug fixes only — which is about mesh not drifting under three
packages being built on it concurrently. It is not the whole picture.
`surfdns/architecture/the-freeze.md` plans **mesh 2 → 3** and says the thing that decides this:

> **The version bump is the last cheap breaking change.** Every interface mistake still in the surface
> on freeze day is permanent, or costs a major version to remove.

Its **Track V** is *"All three items are `defineCrud` semantics, all three are breaking"*, and **V2**
is field-level visibility, described there as *"the single strongest argument for v3 being a real
major rather than a renumbering"*.

So a `defineCollection` wrapper would build a second definition function **during the one window in
which fixing the first is cheap**, and leave the original wrong forever.

### 3.1 Hidden fields — surfdns **V2**, question **A1**

A collection may hold something no caller may ever receive: a password hash, a token hash. Today the
only way to keep it in is to mark every action internal, **which is why nothing on this platform can
turn a user id into a name.**

A hidden field must be enforced in two places, and the second is the one that was missing:

1. **Absent from the output schema**, so a result is stripped on the way out.
2. **Refused in the projection**, so `fields: 'passwordHash'` cannot ask for it.

**(1) alone was not a boundary.** mesh skipped output parsing entirely whenever `fields` was present,
because a projected document is partial and would fail a schema with required fields — so asking for a
projection returned the raw document, hash included.

**Fixed in mesh on 2026-09-11** as a defect rather than a feature: a projected read is parsed against a
*partial* schema, so missing keys are allowed and undeclared keys are still stripped. Both RPC call
sites route through one function, and a test reads the source to assert they still do.

```ts
public static applyReturns(returns: z.ZodTypeAny, projected: boolean, result: unknown): unknown {
    if (!projected) return returns.parse(result);
    return ServiceBroker.partialised(returns).parse(result);
}
```

**(2) still belongs here.** Asking for a hidden field is **an error naming it**, not a silent omission:
a caller who asks has either made a mistake or made an attempt, and both deserve an answer rather than
an empty column. Refusal versus silent drop is **B3**.

### 3.2 Shaping a create input — question **A2**

The same gap on the write side. `create` and `update` must write fields that `find` must not read, and
one declaration has to distinguish them. A password is set and never returned; so is a token. Today
the input schema and the output schema are derived from one base schema, so there is no way to say it.

### 3.3 Two kinds of collection, and publishing crosses between them

`scopedBy` has one answer: a row is in your organization or you cannot see it. That is right, and it is
not enough, because some things are meant to be shared — `serve/kernel` is **owned by one organization
and usable by everyone**.

**The answer is not a flag on the row.** A per-row `visibility` field turns every scoped read into a
union, makes every write check whether it is crossing a line, and puts the most security-sensitive
decision on the platform inside a column an update could change by accident.

**A collection is either scoped or public, declared once:**

| | scoped | public |
| --- | --- | --- |
| read | within the caller's organization | by anyone, including no caller |
| write | permission, within the scope | permission, and only the owning organization |
| carries | `organizationId` | an owner field, for writes |
| examples | repository, site, membership, card | part, version, a blog post |

**Publishing is a contract, not a field change.** It reads from a scoped collection and writes to a
public one, and it is the only thing that crosses. So it has a name, a permission, an audit trail, and
somewhere to put the actual rules — *is this version already published, does this name belong to you,
is the digest reproducible*. A boolean has nowhere to put any of that.

Three consequences:

- **A public collection may be a different shape.** It holds what publishing chose to expose, which is
  usually narrower than the private row. A repository has a URL and a default branch; the part it
  publishes does not.
- **An unscoped read is unbounded, which this platform bans**, so on a public collection pagination is
  **not optional** — a default limit and an enforced maximum. That is surfdns **V1** and **V4**, and
  this is the case that needs them most.
- **Scoped stays exactly as it is.** No union, no per-row check, and `scopedBy` does not change for
  2 → 3. One fewer breaking change in the window.

The unresolved part is not the mechanism, it is **what a public collection's writes are gated by**
(**B1**). Reads are open by construction; creates and updates still belong to an owner, and the owner
field is doing work `scopedBy` used to do for free.

### 3.4 Nested routes

`defineCrud` generates `/{plural}` and `/{plural}/:id` from `pluralPath` and nothing else. A collection
owned by another collection has no way to say so.

```
/organizations/:organizationId/repositories/:repositoryId/parts/:id
/organizations/:organizationId/memberships/:id
/users/:id
```

The two segments are **different in kind**, and conflating them is a real bug waiting to happen:

| | `:organizationId` | `:repositoryId` |
| --- | --- | --- |
| is | the scope, restated in the URL | a genuine parent |
| checked against | the resolved scope from §8 of identity | the collection's own rows |
| mismatch means | **refusal** | 404 |
| why it is there | a URL you can paste, log and reason about | a part without its repository is meaningless |

**`:organizationId` is an assertion to verify, never an input.** A mismatch between it and the resolved
scope is a refusal, not a silent read of the wrong thing.

**And this is what fixes the part namespace.** Today a part name is one global namespace, so a second
organization importing `mesh-web` is refused outright, with a whole error message about it. Under a
nested identity `platform/kernel` and `flowboard/kernel` coexist. **The constraint stops existing
rather than getting a better message.**

---

## 4. Route, query, body precedence

One field can arrive three ways.

> *"when i run sites.create it should take the value from the route over the value from the user
> input. so route, query, body thing."*

**Route wins, then query, then body — because the route value is the one that was verified.**

A body that disagrees with a verified route is **an error, not a value to discard quietly**. Silently
preferring one of two conflicting values is how a caller ends up convinced they wrote something they
did not write.

This layer is mesh-serve's, not mesh's: mesh knows about contracts, not about HTTP.

---

## 5. Relations

`defineCrud` accepts `relations` and every find accepts `populate`:

```ts
interface RelationDefinition {
    localField: string;
    foreignCollection: string;
    foreignField: string;
    as: string;
    isMany: boolean;
}
```

**Nothing in mesh reads either.** They appear in one file, stored on a registry and never consumed.
Declared surface with nothing behind it — rule 5 in [README.md](./README.md), and the clearest example
of it in either repository.

So relations are mesh-serve's to implement, **or to delete from the vocabulary**. Implementing them is
what makes a nested route answerable without the caller making two round trips, which is the whole
reason nested routes are worth having. Whether they belong to mesh or here is **A4**, and it has a
deadline for the same reason everything else in group A does.

---

## 6. Use the typing that exists

This section is not about collections. It is here because every cast in the deleted tree was in front
of a collection call, and the specs are the only place left to say why.

```ts
IServiceContext.call<K extends keyof IServiceToolRegistry>(
    tool: K, params: IServiceToolRegistry[K]['params'],
): Promise<IServiceToolRegistry[K]['returns']>
```

**`ctx.call` is fully typed.** `src/generated/api.ts` augments the global registry from every zod
schema on every contract — 174 entries, regenerated, never hand-written. A cast on the result of
`ctx.call` is not working around a missing type; it is discarding one that was generated for the
purpose.

Three more, for the same reason:

| | is | was used as |
| --- | --- | --- |
| `ctx.meta` | `IMeshMeta`, whose own comment says domain services should augment it | re-declared inline in three files |
| `broker.getProvider<T>(name)` | typed, and `onStart(broker)` hands you the broker | reached via `broker as unknown as { app?: … }` |
| a generated `find` result | `Row[]` from the output schema | cast to a hand-written interface |

The telemetry example is in [fleet.md](./fleet.md) §3 and breaks every rule in
[README.md](./README.md) in six lines.

**The counts, with comments stripped:** mesh-serve 176, mesh-web 98, flowboard 70, mesh-core 30,
mesh-operator 7. mesh itself was written to make these unnecessary, and the user who wrote it almost
rewrote MoleculerJS to get that typing. `as any` and `as never` are defects here, not style.

---

## 7. Open

Field visibility (**A1**), create-input shaping (**A2**), pagination defaults (**A3**), what else goes
in the bump (**A4**), public-collection writes (**B1**), the scope field's name (**B2**) and the hidden
field refusal (**B3**) are in [questions.md](./questions.md).

**Group A is the one with a deadline.** After mesh 2 → 3 ships, each of these costs a major version.
