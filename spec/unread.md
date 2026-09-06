# The reader audit

Every schema field and declared mechanism across mesh-serve and mesh-web, checked for whether
anything actually reads it.

Run 2026-09-05, after a single day produced seven of these by accident. The question each entry
answers is not *is this field written* — they all are — but **who reads it, and what breaks silently
if nobody does.**

---

## Why this is worth a document

A field with no reader is not dead weight. It is a **promise the schema makes and the code does not
keep**, and it fails in the worst available way: the data looks right, the type checks, the comment
explains the invariant, and the behaviour is absent. Nothing errors, because nothing ran.

Seven turned up in one day without looking:

| | found by |
| --- | --- |
| `Role.scope` | writing the admin console spec |
| `partVersion.kernel` | a live release violating it |
| `Build.log` | a build failing with nothing to read |
| `ViewDecl.instances` | a user clicking a button three times |
| `windowPersistence` | a user dragging a window and reloading |
| `defaultOpen` skipping classes | a black page |
| `storage` capability absent | the first part that had to remember something |

Every one was found by *use*, never by review, and each had a careful comment stating the invariant
it was there to hold. **A comment asserting an invariant is the cheapest place in a codebase for one
to quietly not exist.**

## Method, and its one correction

For each field: does any production file read it, as `.field`, as a query key (`{ field: value }`),
or destructured? Tests are counted separately and on purpose — see below.

The first pass searched only for `.field` and reported 24. That was wrong: `build.inputHash` is the
build cache's key and is read as `{ inputHash: hash }` in a `find_one`, which the pattern missed.
Nine of the 24 were that shape. **A naive grep over-reports by 60% here**, so every entry below was
confirmed by reading the call site.

---

## 1. Promises nothing keeps — **act on these**

| field | its comment promises | reality |
| --- | --- | --- |
| `roles.builtin` | *"Shipped with identity and **not deletable**… a deployment with no `public` role has no way to answer an anonymous request at all — a state it should not be possible to configure into"* | Written on every builtin row. **No delete path checks it.** The state it says must be unreachable is one `role.delete` away. |
| `principals.ownerId` | *"surfdns **#29**: an organization whose owner leaves cannot be re-owned. Recorded as a field rather than inferred from memberships so the answer is always available, including when there are no owners left — **which is exactly the case that broke**"* | Written at creation, read nowhere. The field exists to fix #29 and #29 is not fixed. |
| `build.log` | *"a failed build with no log is a bug report nobody can act on"* | Written on every failure. Nothing reads it. Roadmap **F4**. |
| `partVersion.kernel` | *"the only thing standing between a stale part and a browser"* | Roadmap **F5**. A live release already violated it. |
| `Role.scope` | makes surfdns #26 impossible | Roadmap **F3**. The keystone for Track F. |
| `site.image` | *"A path within an artifact this release serves, so it is content-addressed like everything else"* | `page.ts` renders `og:title` and `og:description` and **never `og:image`**. A site sets it and the tag never appears. |
| `descriptor.dependencies` | what a part was built against | Parsed, stored, never verified against what the build resolved. |
| `artifact.declaration.builtAgainst` | *"A dependency at the version that was actually linked, not the one that was asked for… the point of this record is to be a fact something else can compare against"* | Resolved from lockfile and stored on every artifact declaration. Read nowhere in production code. |
| `artifact.declaration.requiredParts` | *"A node holding the bytes can answer what does this need without a catalog lookup"* | Stored on the artifact declaration; `cdn.compose` reads requirements from `partVersion` in the catalog instead. |
| `release.exposure` | *"Recorded here so a mismatch is an error at compose time rather than a confusing 404 three calls later"* | `cdn.compose` never populates it, and nothing in `src/` ever reads it. Roadmap **D5c**. |

`roles.builtin` and `principals.ownerId` are the two new ones, and both are the same shape as `Role.scope`:
a field added to close a specific named incident, holding the right value, consulted by nothing.

## 2. Read only by their own tests — **the sharpest category**

mesh-web's `Manifest` has nine fields. **One is consumed by production code.**

| | src | test |
| --- | --- | --- |
| `manifest.commands` | 1 | 2 |
| ~~`manifest.conflicts`~~ | **1** *(fixed 2026-09-06, mesh-web 0.11.5)* | 6 |
| ~~`manifest.bindings`~~ | **1** *(fixed 2026-09-06, mesh-web 0.11.0 — the keydown handler)* | 6 |
| `manifest.views` | **0** | 1 |
| `manifest.apis` | **0** | 1 |
| `manifest.menus` | **0** | 0 |
| ~~`manifest.layouts`~~ | **1** *(fixed 2026-09-06, mesh-web 0.11.3 — applyLayout)* | 0 |
| `manifest.settings` | **0** | 0 |

`conflicts` is the one that matters. `mergeManifests` detects two contributions claiming the same
command id or the same key binding, records who claimed it, and **reports it to nobody** — the tests
assert the detection works, and no running system ever looks. A green suite is proving a mechanism
that has no effect.

This is worse than an unread field, because the tests make it *look* covered. Six assertions on
`manifest.conflicts` say the feature works. It does. It is also inert.

`manifest.apis` is named in `spec/network.md` §4 as *"the list a review, a CSP or an audit wants"* —
one test reads it and no reviewer can.

## 3. Written for the record — **leave alone**

`artifact.builtAt`, `build.startedAt`, `part.publishedAt`, `release.composedAt`,
`principals.createdAt`, `principals.joinedAt`, `tickets.issuedAt`, `principals.invitedBy`,
`principals.lastUsedAt`, `principals.suspendedReason`, `tickets.revokedReason`, `tickets.via`.

Timestamps and audit strings are read by people and by queries, not by code. Having no caller is
their normal state. They are listed so a future run of this audit does not re-raise them.

The line between this section and §1 is whether the field **encodes an invariant**. `createdAt`
records something. `builtin` promises something.

---

## The rule

**Name the reader, or do not add the field.**

A field whose reader is "someone will query this in mongo" belongs in §3 and should say so in its own
comment. A field whose comment says *cannot*, *never*, *not deletable*, or *the only thing standing
between* is claiming enforcement, and enforcement is code. Two places, and no third.

For a mechanism rather than a field, the test is stricter: **a reader in `src/`, not in `test/`.**
`manifest.conflicts` has six readers and none of them ship.
