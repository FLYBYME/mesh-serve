# Building

**How a release comes to exist.** A repository holds parts, a part is published at a version, a
version is built into an artifact, and a release names a set of versions that compose.

`catalog` and `builder` were two domains. Catalog reads and writes only its own rows; builder reads
catalog and writes into it. **Builder is catalog's writer**, and they are one thing.

**None of this is built.** Where this document says *today*, it is describing `src-dump/`, the deleted
implementation — 4,542 lines across those two domains — and the statement is evidence, not a plan.

---

## 1. The nouns

| | is | is not |
| --- | --- | --- |
| **repository** | a git remote this platform knows about, owned by an organization | a path on a machine |
| **part** | something publishable that lives in a repository | a package |
| **version** | one publication of a part, at a commit | a tag somebody typed |
| **artifact** | the bytes one build produced, named by their digest | a version |
| **release** | a named set of versions that compose | a deployment |
| **site** | a hostname pointed at a release | a release |

Five nouns for what is casually called *"deploying"*, and the separations earn their place:

**A version is not an artifact.** A version is a row saying *this commit is published as 1.4.0*. An
artifact is the bytes. An artifact can be `gone` — an edge's disk is a cache, a pod's storage is
deleted on restart — and the version is still correct, because it names a commit and the build is
deterministic. **`gone` is an observed fact, never a desired state**, and it is the signal to rebuild.

**A release is not a deployment.** Composing produces a release; pointing a hostname at one is a
separate act. **That separation is what makes a rollback picking a row from a list.**

---

## 2. A repository is a first-class row, and today it is a string

This is the largest change these specs ask for.

Today `repository` is a **field on every part** — a git URL repeated on each part that came from the
same place, with nothing keeping them consistent. So:

- *"What repositories does this cluster know about?"* can only be answered by reading every part and
  taking the distinct values.
- A repository cannot be registered before it is imported.
- Nothing records a default branch, or a monorepo's subdirectory, except inline at import time, every
  time.

**One repository holds many parts, and that is already true in practice.** `mesh-core.git` produces
`auth`, `identity` and `ui`. `flowboard.git` produces `flowboard` and `flowboard-agent`. **The data
model does not say so.**

### The collection

```
repository      organizationId    scope, and what makes the namespace work
                name              unique within the organization
                url               a reference any builder on any node can resolve
                defaultBranch     'HEAD' unless said otherwise
                subdirectory?     where the descriptor lives in a monorepo
                credentialRef?    never a credential. A reference to one
```

Scoped by `organizationId`. `name` unique scoped, not global — **that is the whole fix.**

### What it fixes

**The part namespace.** Today a part name is one global namespace, and a second organization importing
a repository whose part names are taken is refused outright:

> `"mesh-web"` is already published by another organization, and a part name is one global namespace
> — so importing … cannot claim it.

With a repository owned by an organization, a part is identified by its path — `platform/kernel`,
`flowboard/kernel` — and the two coexist. **The constraint stops existing rather than getting a better
message.** See [collections.md](./collections.md) §3.4 for the nested route this implies.

---

## 3. The pipeline

```
  register ──► repository row exists. Nothing has been read.
      │
  import ────► read the descriptor, declare the parts it describes.
      │        Creates or updates part rows. Publishes nothing.
      │
  publish ───► mint the next version at a commit. state: declared
      │
  build ─────► clone, resolve, bundle, hash. Produces an artifact.
      │        state: declared → built
      │
  compose ───► resolve version requirements into a release.
      │        Refused here if anything is unmet. Produces a hash.
      │
  deploy ────► point a hostname at a release. Reversible by pointing it back.
```

**Register and import are two steps because a repository can be known before it is read.** That is
what lets an operator add a repository, see it in a list, and import it later — and it is why a
repository is a row rather than a string.

`release_repo` runs publish and build for every part a repository declares, **kernels first**, because
a part's kernel must exist before the part can be built against it.

### States

| | | |
| --- | --- | --- |
| **build** | `queued` → `fetching` → `building` → `succeeded` \| `failed` | one attempt |
| **version** | `declared` → `built` → `gone` | `gone` means rebuildable, not broken |
| **artifact** | `available` → `gone` | the bytes, not the row |

---

## 4. What a build produces

An artifact is named by a **content digest** and is **immutable**. A new build is a new artifact,
never an edit of this one — which is what lets it be cached forever and what makes its digest usable
as a URL.

```
artifact        digest          the name. Content-addressed
                files[]         path, digest, size, contentType
                totalSize
                builtAt
                buildId         which attempt produced it
                declaration     what it is and what it needs
                state           available | gone

declaration     part            kind (kernel | application | extension), id, version, entry
                kernel?         which kernel it targets
                requires[]      capability names
                requiredParts[] other parts, by id and range
                builtAgainst[]  package, version, commit — what was actually resolved
```

**`builtAgainst` is the record that makes a build explicable.** A bundle that behaves differently from
yesterday's has a resolved dependency list attached to it, with commits, and *"what changed"* is a diff
rather than an investigation.

**A digest as a URL is why the CDN is simple.** A file whose name is its hash can be cached forever
with no invalidation, by every layer, and two sites serving the same part serve the same bytes from
the same address.

---

## 5. Composition

`compose` resolves version requirements into a release and records what holds together.

```
release         hash            the identity. Derived from its contents
                name
                tenantId        whose release it is
                kernel          one pinned artifact
                parts           { id → pinned artifact }
                requires[]      capabilities the whole thing needs
                policy          { key → value }
                agentRoles      { role → contract[] }
                rolling         whether it follows its source
                source          what it was composed from
                supersededBy?   set when a newer release replaces it
                composedAt
```

A pinned artifact is `{ version, digest, import? }` — **the version for a person, the digest for a
machine.**

**A composition is refused at compose time, not in a browser.** A release naming a part it does not
have, or a part whose `requiredParts` entry is unmet, fails when it is built. **The failure moves from
a blank page to a build**, which is the whole point of composing at all.

### The import map is the composition boundary

A part bundle imports one bare specifier, and the page resolves it:

```json
{ "imports": {
    "@flybyme/mesh-web": "/_a/285df9b2…/index.js",
    "ui":                "/_a/7c1ab4e9…/index.js"
} }
```

**One bare specifier resolved by the site to exactly one URL is what separates *one kernel, many
parts* from *many kernels pretending*.** Generalising it to one entry per composed part is what lets a
part import another part, and it runs backwards too: **anything the kernel does today that could be a
part can become one**, gaining a map entry and leaving the kernel smaller, instead of the kernel
growing every time a part needs something.

Two sites can then run the same application against different versions of a shared part, and the
release hash already covers the difference.

---

## 6. Idempotency, and running it twice is how you find out

| | running it twice |
| --- | --- |
| register | updates the row |
| import | declares or updates. No new versions |
| publish | mints a version only if the commit moved |
| build | returns the existing artifact when the input hash matches |
| compose | the same parts produce the same release hash, so the same release |
| deploy | a site already serving that release does not change |

**`inputHash` on a build is what makes that true**, and it must cover everything that can change the
output: the commit, the resolved dependencies, the builder's own version. A hash that covers less
produces a cache hit that is wrong, which is worse than no cache at all.

---

## 7. Timeouts are a design constraint here, not a setting

The broker's default call timeout is ten seconds, which is right for a question and wrong for work.
Releasing one repository is a clone and a bundle per part, and has taken **twenty-two seconds on a warm
machine**.

The failure this produced is worth keeping:

> **The caller timed out and reported `RPC Timeout` while the builder carried on and finished every
> part correctly.**

The run failed and the work succeeded, which is the most confusing pair of outcomes available. So:

- **Anything that clones or bundles declares its own timeout.**
- **A caller that gives up must not leave the work unattributed.** A build is a row with a state; the
  caller's patience is not what decides whether it happened.
- **Long work reports progress or it reports nothing.** A call with no output for twenty seconds is
  indistinguishable from a hung one, to a person and to a supervisor.

---

## 8. What must be true

- **A version is minted, never declared.** A repository holding its own version number is a repository
  that must be edited to ship, and a number that can be spent twice.
- **A part belongs to its publisher.** A repository that could name its own owner could name somebody
  else's.
- **A reference, never a path.** A repository must be resolvable by any builder on any node. A local
  bare path resolves on exactly one machine — honest for a laptop, wrong for a fleet (**E4**).
- **A credential is referenced, never stored on the row.** A private repository needs one; a
  collection readable by an organization is not where it lives. What it references is **B4**.
- **The build is deterministic.** Several edges rebuilding a `gone` artifact at once must all produce
  the same digest, or content addressing means nothing.

---

## 9. Open

Whether building belongs in this package at all (**D3**), where a repository credential lives
(**B4**) and where a bare repository path fits (**E4**) are in [questions.md](./questions.md). The
repository collection in §2 is decided and not built.
