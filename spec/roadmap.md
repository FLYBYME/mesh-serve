# Roadmap

What it takes to bring this repository up to its own spec.

Written 2026-09-06. The spec documents describe a system; `src/` is roughly a third of one. This is
the gap, in the order the dependencies actually run.

**★** marks something that blocks several other items. **⛔** names what an item waits on.
Sizes are **S** (an afternoon), **M** (a day or two), **L** (longer, or unknown until started).

---

## Where it actually stands

| | state |
| --- | --- |
| `identity` | **built, and written the wrong way.** Zero `defineCrud`, 8 hand-written contracts, a 160-line hand-rolled store. Moved in from mesh-identity verbatim. |
| `builder` | **built, untested against a real repository.** Service, 3 tools, esbuild, descriptor, content addressing. GridFS is wrong and comes out. |
| `cdn` | **pure functions only.** Site record, hostname rules, resolve, page generation. No service, no port, no edge. |
| `catalog` | **empty.** Three `.gitkeep` files. |
| `api` | **empty.** Three `.gitkeep` files. |
| `fleet` | **empty.** Three `.gitkeep` files. |

109 tests, all unit. Nothing in this repository has ever served a request or built a real
repository.

---

## Track A — Corrections to what is already written

These are wrong now, and everything built on top of them inherits the mistake.

- [ ] **A1 ★ Bytes leave the database.** `src/builder/blobs.ts` puts blobs in GridFS. Decided
      2026-09-06: **the cdn is the object store**, and its disk is a cache — a pod's storage is
      deleted on restart. So the store becomes content-addressed files on the edge's disk, and
      durability comes from *rebuild*, not from replication. **M**
- [ ] **A2 ★ `index.html` is not an artifact.** `methods/page.ts` generates a page artifact to be
      hashed and stored. It is generated **per request** from site + release instead, cached in
      memory keyed on `(siteId, releaseId)` — which is the key that makes invalidation correct by
      construction. Site title and meta go in the document, so crawlers see them. **M** · ⛔ B1
- [ ] **A3 The `/_a/<digest>/` URL scheme goes.** It was built to be shadow-proof when artifacts had
      chosen mount names. With the page generated on the fly, nobody reads these URLs by hand, so
      they stay content-addressed — but the *rule* changes: a release is a set of artifacts, not a
      packaged site, and `Resolution.page` disappears. **S** · ⛔ A2, B1
- [ ] **A4 Rewrite `identity` on `defineCrud`.** 20 hand-written store methods across 7 record types
      are what `defineCrud` generates. The line count is the smaller problem: **those records are
      closed**, reachable only through the 8 accessors somebody thought to write, so every new
      question needs a new contract *and* a new store method. It is the model four other services
      would be copied from. **L**
- [ ] **A5 A unique index on every natural key.** `defineCrud` cannot take one (mesh
      DATABASE_INTEGRATION), so `artifact.digest` and `site.host` are ordinary fields beside a minted
      id. **Two rows can claim the same bytes**, which content addressing exists to prevent. Needs
      the index *and* a check in the writer — the check alone is a race. **S**
- [ ] **A6 A test that builds a real repository.** The builder has never run. Everything about it is
      asserted by unit tests over pure functions, and the last time that was true of the declaration
      reader, running it against one real repository found two defects in an afternoon. Needs a
      fixture repository under `test/fixtures` and a fake fetcher. **M**

## Track B — The catalog

Nothing resolves until this exists. Every version a site names is a row here.

- [ ] **B1 ★★ `part` and `partVersion`.** One `part` collection with
      `kind: 'kernel' | 'application' | 'extension'` — they are the same shape, and three collections
      would be three copies of one resolver. Versions are **their own rows**, never an array on the
      part: an embedded array grows without bound, rewrites the whole document per publish, and
      cannot answer the only query that matters. **M**
- [ ] **B2 ★ A version is immutable.** `(partId, version)` unique. A second publish either matches
      the recorded commit — idempotent, fine — or is refused **naming both commits**. This is what
      makes `^1.4` safe, and without it a range resolves to bytes that can change underneath it. **S**
      · ⛔ B1
- [ ] **B3 The resolver.** Ranges in, exact versions out. A pure function — catalog contents in,
      resolved set out — which makes the hardest logic in the system the most testable thing in it.
      **M** · ⛔ B1
- [ ] **B4 Contract descriptors, so a build can verify.** A site's `mesh[]` names contracts as
      strings; with an imported `ToolContract` a wrong name was a compile error, and now nothing
      catches it. The catalog holds each package's exported contracts, the build asks, and the
      failure is a refusal instead of a 404 nobody can distinguish from a route that never existed.
      **M** · ⛔ B1
- [ ] **B5 Policy on the version.** Decided 2026-09-06. Three levels that must not be blurred:
      **declared** (`needs: []` — compose-time refusal, defeated by an author who calls `fetch`),
      **checked** (the build scans the bundle — defeated by obfuscation), **enforced** (CSP, defeated
      by nothing). CSP is per-document, so *enforced* is a property of a whole release: one part
      needing network makes the page network-capable. **M** · ⛔ B1
- [ ] **B6 Who may publish.** A `partVersion` row is what a site resolves to, so whoever writes one
      can change what runs on someone else's hostname. **M** · ⛔ B1, C1

## Track C — Releases and the cdn edge

- [ ] **C1 ★ The `release` collection.** A kernel and N parts at exact versions, plus policy,
      **referenced by a derived hash** — sha256 over its contents, canonically ordered, so two people
      composing the same set land on the same release without coordinating. It is not a packaged
      artifact: it is a *set* of artifacts. **M** · ⛔ B1, B3
- [ ] **C2 `site` loses its composition.** `kernel`, `parts`, `mesh` and `policy` move to the
      release; `site` keeps host, tenant, api, theme tokens, and gains title and SEO. Then staging
      and production referencing one release are **provably** identical, and rollback is one write.
      **S** · ⛔ C1
- [ ] **C3 ★ `CdnEdgeService` — the thing that binds a port.** Modelled on paas's `DnsEdgeService`:
      same domain, its own class, an in-memory projection kept fresh by **events for latency and a
      `resync` tool for correctness**, because the mesh delivers at-most-once. Third time this shape
      has been the answer. **L** · ⛔ A1, A2, C1
- [ ] **C4 The edge registry.** One row per running edge: id and **url**. Not liveness — the mesh
      already knows which nodes are up, and a second heartbeat beside it is two sources of truth that
      disagree during exactly the incident where it matters. **S** · ⛔ C3
- [ ] **C5 ★ Artifact sync between edges.** The hard one. An edge needs digest D and does not have
      it: find a peer that does, fetch over **HTTP, not the broker** — a kernel bundle is megabytes
      and the broker is for control messages. Announce at **artifact** granularity, fetch at **blob**
      granularity, so a one-line change does not re-fetch a whole kernel. **L** · ⛔ C3, C4
- [ ] **C6 `gone`, and rebuild.** No edge holds it → mark the artifact gone → rebuild from the
      catalog's commit. Safe because the build is deterministic: ten edges discovering it
      simultaneously all produce the same digest, so duplicate work is wasted and harmless. **This is
      the only durability story there is** — the edge disk is a cache and git is the archive. **M** ·
      ⛔ C5, B1
- [ ] **C7 Eviction is a refcount, not a policy.** An artifact is removable when no release a live
      site names resolves to it. That makes deleting a site remove *its* composition while the kernel
      and shared parts survive — which is also the legal answer. **S** · ⛔ C1
- [ ] **C8 Part CSS needs scoping and a token rule.** Decided 2026-09-06 that parts ship their own
      styles. Two consequences: two parts both shipping `.panel` collide silently, and a part
      hardcoding `background: #161b22` **cannot be re-themed** — which is the whole point of tokens.
      Both are checkable at build time. **M**

## Track D — The api

- [ ] **D1 Move it out of mesh-api before mesh-api is deleted.** 2,923 source lines and 2,713 test
      lines, including the only implementations of the REST/SSE server, the gate, and
      `SCOPE_HEADER`. **Order matters: move, then delete.** **L**
- [ ] **D2 ★ Routes come from the record.** Host → site → release → `mesh[]` → routes, exactly as the
      cdn resolves Host → site → artifact. Same cache, same invalidation. It makes the gate **per
      site**: one site may expose `domains.zone_find` as public while another requires `user`. **M** ·
      ⛔ C1, D1
- [ ] **D3 ★ Scope must reach `defineCrud`.** This is the specific way 100,000 lines of paas went
      wrong. The `authorize` hook already takes a requested scope and returns a resolved one;
      `defineCrud` has no idea it exists. **Authorization can refuse a caller but cannot narrow a
      result set**, so an unbounded `find` returns every row there is and no contract could have said
      otherwise. Until this lands, "never expose an unbounded find" is a discipline, and disciplines
      are what paas had. **L** · ⛔ D1
- [ ] **D4 The exposure hash.** The API reports it, the generated client carries it, a mismatch is an
      error rather than a confusing 404 three calls later. *A client generated from one exposure and
      pointed at an API serving another is a lie the compiler vouches for.* **S** · ⛔ D1, D2
- [ ] **D5 The client generator has to live in mesh-web, not here.** A part repository already
      depends on the browser framework and must never depend on the server — putting it here makes
      every UI repository install a web server to get types. mesh-auth is waiting on it right now:
      it hand-writes `IssueReply` and `WhoamiReply`, a second copy of this repository's identity
      output schemas with nothing checking they agree. **M** · ⛔ D1

## Track E — Fleet

Shape decided, nothing built. See [fleet.md](./fleet.md).

- [ ] **E1 `node` and `assignment`.** A node joins, says *my name is x, what should I run?*, and the
      fleet only ever answers. It never starts a process — something else always does — which is why
      one mechanism covers a laptop and a cluster. **M**
- [ ] **E2 The observed half.** A node reports what it actually mounted, **including mount
      failures**. A desired-state system whose observed side is optimistic is worthless. **M** · ⛔ E1
- [ ] **E3 Two nodes may not claim one name.** With a singleton assigned to it, both mount it and you
      have split-brain with no error anywhere. **S** · ⛔ E1
- [ ] **E4 Nothing in `src/fleet/` imports another service here.** It is the recovery path: if fleet
      needed the cdn, a broken cdn would mean you cannot fix the cdn. Enforced by a check, not a
      convention. **S**

---

## The shortest path to something real

The first thing that could actually be looked at, in order:

**B1 → B2 → C1 → A1 → A2 → C3** — a catalog with immutable versions, a release that names them, bytes
on disk instead of in mongo, a page generated per request, and an edge that binds a port and serves
it. A6 belongs anywhere in there and the sooner the better, because the builder has still never run.

Everything else — sync, gone-and-rebuild, the api, fleet — is what makes it survive more than one
node. None of it matters until one node works.
