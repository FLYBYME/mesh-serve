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
| `catalog` | **collections, resolver and tools written.** Immutability enforced in `publish`. The tools have never run against a broker. |
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
- [x] **A5a The builder can clone a private repository.** *(built 2026-09-06)* `GIT_TOKEN_<HOST>` on
      the node, sent as `http.extraHeader` and **never in the remote URL** — a URL with a token in it
      reaches `.git/config`, git's error messages, and therefore the build log, which is stored on
      the build row and travels with the failure. Redacted from any error that escapes, and a fetch
      that fails with no credential says so, because a private repository is otherwise
      indistinguishable from one that does not exist.
- [ ] **A5b ★★ `build_start` takes a part, not a URL.** *(found 2026-09-06, immediately)* The caller
      names the repository, so **a node holding a token that can read `surfdns` will clone it for
      whoever asks**, bundle it, and publish an artifact the same caller can fetch by digest. That is
      not a flaw in the token; it is `build_start` accepting an arbitrary URL while holding a
      credential.
      The catalog already fixes it: a `part` row carries `repository` and `publisher`, so the input
      becomes `{ part, version }`, the repository comes from the catalog, and the caller is checked
      against the publisher. There is then no field in which to name someone else's repository — and
      a build becomes reproducible from the catalog alone, which is what `gone` → rebuild needs
      anyway. **M** · ⛔ B1
- [ ] **A5c A tarball source is not durable.** `archive` is in the schema and is the right answer for
      a source the builder cannot reach — no credential, no clone. But everything rests on *the edge
      disk is a cache and git is the archive*, and an uploaded tarball has nothing behind it: lose
      every copy and the version is gone rather than `gone`. It has to be stored durably or marked
      unreproducible before anything is published from one. **M** · ⛔ C6
- [ ] **A6 A test that builds a real repository.** The builder has never run. Everything about it is
      asserted by unit tests over pure functions, and the last time that was true of the declaration
      reader, running it against one real repository found two defects in an afternoon. Needs a
      fixture repository under `test/fixtures` and a fake fetcher. **M**

## Track B — The catalog

Nothing resolves until this exists. Every version a site names is a row here.

- [x] **B1 ★★ `part` and `partVersion`.** *(built 2026-09-06)* One `part` collection with
      `kind: 'kernel' | 'application' | 'extension'` — they are the same shape, and three collections
      would be three copies of one resolver. Versions are **their own rows**, never an array on the
      part: an embedded array grows without bound, rewrites the whole document per publish, and
      cannot answer the only query that matters.
      A version starts `declared` — the row exists and is buildable before any bytes do — and can go
      `gone`, which is not an error but the signal to rebuild.
- [x] **B2 ★ A version is immutable.** *(built 2026-09-06)* Enforced in `catalog.publish`: the same
      commit is idempotent, because a CI job that runs twice is not an error, and a different commit
      is refused **naming both**. Without it `^1.4` resolves to bytes that change underneath it and
      every site pinning that range silently gets different code.
      The part's own identity is fixed at first publish too — `mesh.json` is the genesis object, and
      a repository that later changes `kind` is describing a different part.
- [x] **B3 The resolver.** *(built 2026-09-06)* `methods/semver.ts`, pure, 26 tests. The two that
      carry the weight: **the 0.x caret rule**, since the kernel is 0.2.0 and `^0.2` must not match
      0.3.0 — that is the live case, not a corner one — and **prereleases staying out of ranges**,
      since getting it wrong ships a release candidate to every site tracking `^1.0`.
      An unsupported range is reported as unsupported rather than matching nothing, because a range
      nobody implemented looks exactly like a part nobody published.
- [ ] **B3a Neither tool has run against a broker.** `publish` and `resolve` typecheck and their pure
      halves are tested; the CRUD calls in them have never executed. This is the same gap that made
      the declaration reader look finished. **S** · ⛔ A6
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
- [x] **D5 `mesh-serve client` — a part's `mesh.json` into typed API code.** *(built 2026-09-06)*
      mesh-api's `describeExposure`, `emitClient` and the JSON-Schema-to-TypeScript emitter salvaged
      into `src/api/`; the missing half — producing a descriptor **from what a part declares it
      calls** — is `src/api/client-cli.ts`. mesh-auth's `IssueReply` and `WhoamiReply` are generated
      now instead of hand-written.
      Two things it found on its first real run, which is the argument for running things:
      **`identity.ticket_revoke` is `internal` and the extension called it** — correctly internal,
      because it takes `{ token?, userId? }` and `userId` revokes everyone else's tickets. Sign-out
      needs its own narrow contract. See D5b.
      And the CLI's own first version read `parts[].mesh[]` by hand and reported *"declares no
      contracts"* for a file that plainly declared three — because mesh-auth uses the flat
      single-part form. It uses `parseDescriptor` now: one parser, so a shape either half can write
      is a shape both understand.
- [ ] **D5d ★ The client is generated by the cdn, not bundled into the part.** *(decided 2026-09-06)*
      A committed client carries `base: "/api"` and gets bundled, so it cannot hold a site's real API
      origin — and one artifact serves every site, so it must not try.
      The part imports a bare specifier, esbuild leaves it `external` exactly like the kernel, and the
      import map resolves it:
      ```json
      { "imports": { "@flybyme/mesh-web": "/_a/9f2c1a/index.js", "@flybyme/site-api": "/_api.js" } }
      ```
      Three things fall out. **One part artifact serves every site**, because the site-specific half
      was never in it. **The base path is real**, because the cdn knows the site's `api` when it
      generates the page. And **the exposure hash finally checks something** — the cdn generates from
      the site's actual grants and gates, which is the hash an API reports, closing D5c from the only
      side that can close it.
      `src/generated/api.ts` stays in the part repository as **types for the editor**, never bundled —
      the same standing `@flybyme/mesh-web` has as a devDependency that never ships. **M** · ⛔ A2
- [ ] **D5a It still lives in the wrong repository.** A part repository must never depend on the
      server, and running this today means mesh-auth installs mesh-serve to get types — exactly what
      `spec/exposure.md` §4 objects to. The split that fixes it: **descriptor generation stays here**
      (it needs the contracts), and **descriptor → types moves to mesh-web**, so a part regenerates
      offline from its committed `descriptor.json`. **M**
- [ ] **D5b `identity.sign_out`, public and narrow.** Revokes *the calling ticket* and nothing else,
      takes no input. `ticket_revoke` cannot be the browser's sign-out because it can name a
      `userId`. Until it exists, mesh-auth's `signOut` posts to a path it declares nowhere. **S**
- [ ] **D5c A part's exposure hash is not the site's.** The descriptor a part generates uses one
      placeholder gate for every entry, because a part must never choose its own — so its hash is
      over shapes, not over the real exposure, and cannot be compared with what an API reports. The
      check belongs at **compose time**, where the site's grants are known. **S** · ⛔ D4, C1

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

~~B1 → B2 → B3~~ **→ C1 → A1 → A2 → C3** — a catalog with immutable versions ✓, a release that names
them, bytes on disk instead of in mongo, a page generated per request, and an edge that binds a port
and serves it. A6 belongs anywhere in there and the sooner the better, because the builder has still
never run — and B3a is the same gap in the catalog.

One thing the catalog surfaced that has to be answered before anyone but us publishes: **part names
are a flat global namespace.** Two publishers both wanting `auth` collide, and renaming a part breaks
every site that names it. npm answers with `@scope/name`. Whatever the answer is, it is cheap now and
expensive later.

Everything else — sync, gone-and-rebuild, the api, fleet — is what makes it survive more than one
node. None of it matters until one node works.
