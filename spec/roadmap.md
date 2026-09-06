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
| `builder` | **works.** Fetches a commit, bundles with esbuild, publishes one artifact per part, caches by input hash, and refuses a part it does not own. Bytes on disk. |
| `cdn` | **serves.** Binds a port, resolves Host → site → release → artifact, generates the page per request, composes and deploys. |
| `catalog` | **works.** `part` and `partVersion`, a pure resolver, immutability enforced in `publish`. |
| `api` | **the generator only** — `mesh-serve client`, salvaged from mesh-api. No server. |
| `fleet` | **empty.** Three `.gitkeep` files. |

216 tests, and 13 of them are the spine running for real: a `MeshApp` with mongo, a git repository at
a commit, esbuild, a bound port. **M1 is done.** What is unproven now is everything about surviving
something — a second node, a lost disk, a caller who should be refused.

---

## Track A — Corrections to what is already written

These are wrong now, and everything built on top of them inherits the mistake.

- [x] **A1 ★ Bytes leave the database.** *(done 2026-09-06)* `src/builder/blobs.ts` puts blobs in GridFS. Decided
      2026-09-06: **the cdn is the object store**, and its disk is a cache — a pod's storage is
      deleted on restart. So the store becomes content-addressed files on the edge's disk, and
      durability comes from *rebuild*, not from replication. **M**
- [x] **A2 ★ `index.html` is not an artifact.** *(done 2026-09-06)* It was going to be hashed and
      stored like everything else, on the argument that the page should not be the one thing that is
      not content-addressed. The site record made that wrong: a page carries the site's `title`,
      `description` and canonical URL, so **two hostnames on one release do not have the same page**,
      and content-addressing a per-site document means an artifact per site — the coupling releases
      exist to remove.
      It is a *response* now, built from site + release, cacheable in memory on `(siteId,
      releaseHash)` — the key that makes invalidation correct by construction. What that buys is the
      metadata reaching the **document**: a title injected by script is a title a crawler never sees,
      and on a window manager what a part renders is invisible to one anyway.
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
- [x] **A5b ★★ `build_start` takes a part, not a URL.** *(found and closed 2026-09-06)* The caller
      named the repository, so a node holding a token that can read `surfdns` would clone it for
      whoever asked, bundle it, and publish an artifact the same caller could fetch by digest — not a
      flaw in the token, a flaw in accepting an arbitrary URL while holding one.
      Input is `{ part, version }`; repository, commit, entry and requirements come from the catalog,
      and the caller's tenant is checked against `part.publisher`. A caller with no identity is
      refused rather than allowed, because defaulting to *allow* is how a check becomes decorative,
      and a mismatch answers **404 rather than 403** — which organization publishes a part is not
      something an unrelated caller gets to confirm by probing.
      Two things fell out. **`mesh.json` is no longer read by a build at all**, so a repository that
      edits its descriptor cannot change what an already-published version builds — the same
      immutability that makes a range safe. And a build is now reproducible from the catalog alone,
      which is exactly what `gone` → rebuild needs: the security fix and the durability path were the
      same change.
- [ ] **A5c-i ★ `mesh.json` carries no description, and a marketplace is a list of names.** A part
      declares `kind`, `id`, `version`, `entry` and what it calls — everything a *build* needs and
      nothing a *person choosing one* needs. `part.description` exists in the catalog and there is no
      field anywhere that fills it.
      The distinction that decides the shape: **identity is immutable, presentation is not.** `id`
      and `kind` are fixed at first publish and a version's `commit` can never move — but a typo in a
      description, a new icon, a screenshot, a changed homepage must all be fixable without minting a
      version, because a version means *this code*. So presentation lives on the `part` row, updated
      by whatever publishes, and never on `partVersion`.
      The exception is anything a person needs to read **per version**: a summary of what changed. A
      changelog entry belongs to the version and is immutable with it.
      Worth having before a marketplace exists rather than after, because a store showing a grid of
      bare ids is the thing that makes people write descriptions into names. Likely: `description`,
      `homepage`, `license`, `keywords`, `icon` (a path within the artifact, so it is content-
      addressed like everything else), and `changelog` on the version. **S**
- [ ] **A5b-i `mesh-serve publish` needs a broker connection.** It reads `mesh.json`, refuses a dirty
      tree, resolves the commit and remote, and prints what it would publish — but writing it means
      calling `catalog.publish`, and the CLI opens no broker. Writing rows directly would be a second
      path into the catalog that skips the immutability check, which is the one thing that collection
      exists to enforce. **S**
- [ ] **A5c A tarball source is not durable.** `archive` is in the schema and is the right answer for
      a source the builder cannot reach — no credential, no clone. But everything rests on *the edge
      disk is a cache and git is the archive*, and an uploaded tarball has nothing behind it: lose
      every copy and the version is gone rather than `gone`. It has to be stored durably or marked
      unreproducible before anything is published from one. **M** · ⛔ C6
- [x] **A6 A test that builds a real repository.** *(done 2026-09-06)* The builder has never run. Everything about it is
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
- [x] **B3a Both tools run against a broker.** *(done 2026-09-06)* `publish` and `resolve` typecheck and their pure
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

- [x] **C1 ★ The `release` collection.** *(built 2026-09-06)* A kernel and N parts at exact versions,
      plus policy, **referenced by a derived hash** — sha256 over the *digests*, canonically ordered,
      so two people composing the same set land on the same release without coordinating. Hashing
      versions instead would make two releases equal while serving different code, which is the one
      thing a release exists to rule out. `tenantId`, `name` and `composedAt` are deliberately not
      inputs: two organizations composing the same set have composed the same thing.
      `checkComposition` alongside it, and the distinctions are the point: a **required** part that is
      absent refuses, an **optional** one reports, an unmet **contract** refuses, and an unused grant
      reports. Everything is returned at once, because somebody composing five parts wants five
      answers.
- [x] **C2 `site` loses its composition.** *(built 2026-09-06)* `kernel`, `parts` and `resolution`
      are gone; the site names a `releaseHash`, and **that one field is the deploy**. `mesh` stays,
      because what a hostname exposes and at what gate is a deployment's decision — one site may
      expose a contract as `public` while another requires `user`, on one release. Gained `title`,
      `description`, `canonical`, `image` and `indexable`, which reach the generated document.
- [x] **C2a `cdn.compose` and `cdn.deploy` have handlers.** *(done 2026-09-06)* Both contracts are written and neither
      has a tool behind it: `compose` resolves against the catalog, runs `checkComposition` and
      writes the row; deploying is `site.update` plus the event. The pure halves are tested; the
      wiring is not written. **M** · ⛔ B3a
- [x] **C3 ★ `CdnService` — the thing that binds a port.** *(done 2026-09-06)* Modelled on paas's `DnsEdgeService`:
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

- [x] **D1a ★ Server-sent events.** *(built 2026-09-06)* `methods/stream.ts` on `node:http`, an
      `/events` subscription per site, 8 integration tests. The transport is small; what it protects
      is not.
      **Two failures are refused at subscribe time rather than streamed silently**, and they are the
      same failure from opposite sides: an event whose definition declares no `scopedBy` can never be
      narrowed to anybody, and a subscriber who resolved no scope can never be narrowed *to*. Either
      one opens a stream that is correct, quiet and impossible to distinguish from a working one — so
      both answer with a reason instead.
      The second has a specific cause worth naming: **a site that streams scoped events and configures
      no `authorize` hook has built a stream that can never deliver.** Only a site knows what an
      organization means to it, so the coarse gate cannot resolve a scope on its own. Found by writing
      the test — the positive case failed while every negative case passed, which is exactly what
      "nothing is ever delivered" looks like.
      **The caller is re-resolved on every heartbeat.** A stream outlives the request that opened it,
      so a ticket revoked five minutes in must reach a connection authorised ten minutes ago —
      otherwise revoking a session closes the door and leaves the window open.
- [x] **~~D1a~~ original entry** *(audited 2026-09-06)*
      Everything else is moved or deliberately dropped. The **decisions** are saved —
      `api/methods/delivery.ts` and `api/schema/events.ts` — and they are the part that matters:
      *an event that cannot be scoped is delivered to nobody*, which replaced a version that read a
      payload/contract disagreement as *"unscoped, send to everybody"* and put one organization's
      data on every connected browser. That is the unbounded-find bug one level over.
      What remains is the **transport**, needing the same rework `rest.ts` got: mesh-api mounts a
      static express route, and a subscription now depends on which hostname asked. `site.mesh`
      gained an `events` list for it — separate from `contracts` although the keys look identical,
      because a contract key resolving to nothing 404s while an event key resolving to nothing
      **connects and stays silent forever**, which is far worse to diagnose.
      **⛔ blocked on mesh, not on effort**: `EventDefinition` is `{ name, schema }`, so an event
      cannot say which field of its payload names an organization, and `decideDelivery` therefore
      refuses every scoped event. Queued as mesh dispatch 4. **M**
- [ ] **D1 Move it out of mesh-api before mesh-api is deleted.** **Not a port** — the shape is decided
      in [exposure.md §6a](./exposure.md). The api is the cdn's twin: `Host → site`, bind a port,
      same records, same invalidation; one serves files and the other serves calls.
      **It owns no collections**, which makes it unlike the other three services — `site.mesh` is the
      cdn's, tickets are identity's, and the exposure hash is derived from both. `mountCrud` is called
      zero times.
      Kept: `gate.ts` (`SCOPE_HEADER` and its argument), the ticket cache and revocation poller,
      `input.ts`'s query coercion, and `rest.ts`'s error mapping and `DeclaredFailure`.
      **Dropped: `rest.ts`'s structure and express.** It takes `expose: ExposeEntry[]` and mounts one
      route per contract *at boot*, and a fixed route table known at startup is precisely what D2
      replaces. The cdn proved `node:http` answers *resolve a host, look up a table, reply* without a
      framework. **L**
- [ ] **D2 ★ Routes come from the record.** Host → site → release → `mesh[]` → routes, exactly as the
      cdn resolves Host → site → artifact. Same cache, same invalidation. It makes the gate **per
      site**: one site may expose `domains.zone_find` as public while another requires `user`. **M** ·
      ⛔ C1, D1
- [x] **D3 ★ Scope reaches `defineCrud`.** *(mesh v2.2.0, adopted 2026-09-06)* `siteCrud` declares
      `scopedBy: 'tenantId'`, so every generated read and write is inside the caller's organization —
      `find` is scoped, `create` stamps the field, `update` cannot reparent a row, and a cross-scope
      `get` answers **404** rather than 403. *Never expose an unbounded find* stopped being a
      discipline and became a mechanism, which is the difference between this and the 100,000 lines it
      is replacing.
- [x] **D3a ★★ Adopting `scopedBy` breaks the serving path, and that was the interesting part.**
      *(closed 2026-09-06)* `cdn.resolve_site` is the second door: public, one site by exact hostname,
      nothing to enumerate with.
      **The first version of it did not work, and the reason is worth keeping.** It called
      `site.find_one`, which is scope-restricted — so every page request 404'd, because the caller is
      a browser and a browser has no organization. *A door that opens into the same locked room is not
      a second door.* So the tool reads the collection directly, and that bypass is confined to four
      lines with a stated invariant rather than granted to the whole serving path: one function can be
      reviewed, a serving path with database access cannot.
- [ ] **~~D3a~~ superseded — original entry**
      *(found 2026-09-06, reviewing mesh `dispatch/2`)* The framework change is built and good — reads
      and writes both scoped, `create` stamps the field, `update` strips it so a patch cannot reparent
      a row, a cross-scope `get` answers **404 not 403**. It fails closed twice over: a caller with no
      scope is refused, and so is an internal call carrying no caller.
      **That second decision is the one that bites here.** `cdn.service.ts:261` and
      `api.service.ts:272` both resolve `site.find_one({ query: { host } })` with **no caller at
      all**, because a browser fetching a page is anonymous. Put `scopedBy: 'tenantId'` on `siteCrud`
      and every page request is refused with 401.
      The dispatch's own answer — *internal callers use `Database.repo()` directly* — works and costs
      too much: the serving path would stop going through contracts, which is the thing that lets any
      node serve any site.
      **The better answer is already this repository's rule**: anything with an invariant is an
      explicit contract. Resolving a hostname *for serving* is a different operation from *listing my
      sites*, and its invariant is exactly that it returns one site by hostname and can never
      enumerate. So `cdn.resolve_site` is public and unscoped by construction, `site.find` becomes
      scoped and is never exposed, and the two callers stop sharing one door.
      **S**, and it must land in the same change as D3 rather than after it. **⛔** mesh `dispatch/2`
- [ ] **D3 ★ Scope must reach `defineCrud`. *This is a change to mesh, not to the api.*** The api can
      resolve a caller's organization into `meta`; it cannot make a generated `find` use it, because
      the query is built inside the framework's CRUD path. Writing the filter in the api instead
      would be a second copy of authorization sitting beside a path that bypasses it. The shape the
      framework needs: `defineCrud('site', SiteSchema, { scopedBy: 'tenantId' })`, so an unscoped
      find is unrepresentable rather than discouraged. This is the specific way 100,000 lines of paas went
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

## Track F — Managing the platform

Found while specifying an admin console. See [managing.md](./managing.md). **None of these is a UI
task** — each is a decision about the platform's own surface that blocks any UI at all.

- [ ] **F1 No event can be streamed.** All four — `catalog.version_published`, `cdn.release_composed`,
      `cdn.site_deployed`, `builder.artifact_published` — declare no `scopedBy`, and an event that
      cannot be scoped is delivered to nobody, so the api refuses every one at subscribe. **Two of
      the payloads carry no tenant field to scope by**: `site_deployed` has `host`/`release`,
      `release_composed` has `hash`/`kernel`/`partCount`. They were written for another *service* to
      consume; a browser is a different audience. **S**
- [ ] **F2 Nothing is exposable.** Every CRUD action on every collection is `internal`, correctly by
      default — so catalog has **no** public contract, cdn has only `resolve_site`, builder only
      `get_artifact`. A console cannot list parts, builds or sites: not refused, no route at all.
      Decide the smallest exposable set per service. **M** · ⛔ D1
- [x] **F3 ★ `Role.scope` is enforced.** *(done 2026-09-06)* `schema/roles.ts` makes
      `scope: 'cluster' | 'organization'` **required**, and says why: #26 exists because `admin` meant
      organization-scoped in one place and cluster-scoped in another, so nobody could be a platform
      operator. A cluster-scoped role *is* the operator concept — the design is complete. Enforced:
      `permits` takes resolved `Role` rows and `organizationId`, granting cluster-scoped roles everywhere
      and organization-scoped roles only in an organization; write points validate against the store
      (refusing organization-scoped roles in `user.roles` and cluster-scoped roles in `membership.roleKey`).
      **Operator contracts need no new mechanism and `scopedBy` never learns about bypasses.** **M**
- [ ] **F5 ★ `partVersion.kernel` is stored and never read, and a live release already violates it.**
      `publish-cli` writes the range a part was built against, with the comment *"the only thing
      standing between a stale part and a browser"*; `build_start` forwards it. **Nothing reads it** —
      `checkComposition` checks missing parts, unmet contracts and unused grants, and has no kernel
      case at all. It is not theoretical: the live release is kernel **0.5.0** with `auth@0.1.0`,
      which declares `kernel: ^0.4` and depends on `@flybyme/mesh-web: 0.4.0`. `^0.4` is
      `>=0.4.0 <0.5.0`, so compose accepted an out-of-range part without a word. Add a
      `kernel_mismatch` problem, fatal. **S**
- [ ] **F6 ★ `publish-cli` mints its own caller, and nothing checks it.** The CLI joins the cluster as
      a **node**, and *a node must never hold a user credential* — so the generated `ToolCommands.ts`
      passing no `meta.user`, and `site.find` refusing it, is both halves working as designed:

      ```
      $ npx mesh site find --bootstrap ws://127.0.0.1:4001
      Error: Scoped collection "site" requires a resolved "tenantId" scope, but none was
      provided in call context.
      ```

      `publish-cli` is the one that breaks the rule. It sends
      `{ meta: { user: { id: 'cli', tenant_id: args.publisher } } }`, where `publisher` is a **bare
      `--publisher` flag with no credential behind it**. So `catalog.publish`'s ownership check —
      *"mesh-web belongs to another publisher"* — is checkable and trivially forged: anyone who can
      reach the mesh port publishes as anyone. A node asserted a user, which is precisely the plane
      separation that exists to make this impossible.
      **The fix is not a flag on the other CLIs.** An operator presents a *credential* — a ticket
      from identity — and platform-wide reads go through operator contracts gated by a cluster-scoped
      role (F3). A `--as-tenant` option would be the `scopedBy` bypass managing.md §2 rejects, handed
      out on the command line. **M** · ⛔ F3
- [x] **F8 ★ `roles.builtin` and `principals.ownerId` are enforced.** *(done 2026-09-06)* From the reader
      audit, [unread.md](./unread.md). Both are the same shape as F3: a field added to close a named
      incident, holding the right value, consulted by nothing.
      `builtin` says *"not deletable… a deployment with no `public` role has no way to answer an
      anonymous request at all — a state it should not be possible to configure into."* Enforced:
      `deleteRole` rejects builtin roles with `ClientError` (400 `BUILTIN_ROLE`), and `authenticated`
      was corrected to `builtin: false` matching spec.
      `ownerId` says *"surfdns #29: an organization whose owner leaves cannot be re-owned… including
      when there are no owners left — which is exactly the case that broke."* Enforced:
      `ownerId` is recorded on the organization document as the definitive authority, surviving the
      removal or departure of owner memberships, and backed by `transferOwnership` (requiring current
      owner) and `reownOrganization` (allowing the recorded owner to restore membership if all owners leave). **S**
- [ ] **F9 `site.image` is stored and never rendered.** `page.ts` emits `og:title` and
      `og:description` and no `og:image`. A site sets the field, the tag never appears, and nothing
      says so. One line in the page generator. **S**
- [ ] **F7 `--version` collides with commander's own flag, silently.** Any contract with a `version`
      input is uninvokable from the generated CLI: commander owns `--version` on the program and
      prints the CLI's version instead of running anything.

      ```
      $ npx mesh builder build_start --part todo --version 0.1.0
      1.0.0
      ```

      **Exit 0, no build, no error** — the failure mode is a command that looks like it worked. It
      hits `builder.build_start`, `catalog.publish` and all eight `partVersion` commands. The
      generator must either rename colliding options or stop registering a program-level `--version`.
      Belongs in mesh's `GenerateCommand`. **S**
- [ ] **F4 Nothing reads a failed build's log.** `BuildSchema` carries `log` and `error` precisely
      because *a failed build with no log is a bug report nobody can act on* — and no reader exists.
      The single most valuable screen, and it needs F2 and nothing else. **S** · ⛔ F2

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

## Milestones

Tracks say what is left. These say **when it becomes usable**, and each is defined by something that
becomes demonstrably true rather than by a count of items closed.

Every one of them is gated on the same thing at the moment: **nothing here has ever run.** A6, B3a
and C2a are one gap wearing three names — no CRUD call executed, no repository bundled, no HTTP
request answered.

### M1 — A hostname serves a site composed from published parts ✅ *2026-09-06*

*The spine, end to end, on one node.* `test/integration/spine.test.ts` — a real `MeshApp` with a real
mongo, a real git repository at a real commit, real esbuild, a real port. 13 tests:

```
catalog.publish  →  builder.build_start  →  cdn.compose  →  cdn.deploy  →  GET / → 200
```

It proved the properties rather than the plumbing: a version is idempotent from the same commit and
refused from a different one; two parts in one repository become two artifacts; a second build is
cached; a build for another organization is refused; composing the same set twice returns the same
hash; the page carries its title and description in the **document**; the kernel it names is
fetchable and `immutable`; an artifact the release does not contain is a 404.

**A1 · A6 · B3a · C2a · C3** all closed by it. **mesh-web A9.1c** is *not* — the generated boot module
still calls a `start()` the kernel does not have, so the page loads and the parts fetch, and nothing
boots. That is A0 of M1's follow-through, not a gap in the spine.

**Why it was first**: everything after it is about surviving something, and until one node serves one
page there is nothing to survive.

### M2 — It survives losing a disk

*An edge is a cache and git is the archive.* Kill an edge's storage, restart it, and the site still
serves — either because another edge had the bytes, or because the artifact went `gone` and was
rebuilt from the catalog's commit.

⛔ **C4** the edge registry · **C5** sync between edges · **C6** `gone` and rebuild

This is the one that makes it a platform rather than a demo, and it is already *designed* to be
cheap: builds are deterministic, so several edges rebuilding at once converge on the same digest and
the duplicate work is harmless.

### M3 — Calls are gated and scoped

*A site exposes contracts and the API refuses what it should.* Host → site → release → routes, with a
caller's organization resolved and applied.

⛔ **D1** move the api out of mesh-api *before it is deleted* · **D2** routes from the record ·
**D3** scope reaching `defineCrud` · **D4** the exposure hash · **A4** identity rewritten on CRUD

**D3 is the milestone.** Until it lands, *never expose an unbounded find* is a discipline — and a
discipline is exactly what paas had.

### M4 — Somebody who is not us can publish a part

*The marketplace point.* A third party publishes a version, a site composes it, and every check that
protects the site from it actually runs.

⛔ **B4** contract verification at build time · **B5** policy on the version · **B6** who may publish
· **A5c-i** descriptions, or a store is a grid of bare ids · **D5d** the client generated by the cdn
· **D5a** the generator moved to mesh-web · **A5** unique indexes on natural keys

Also the point at which **part names being a flat global namespace** stops being a note and becomes a
migration.

### M5 — A node joins and is told what to run

*The standard way to run a service anywhere.* Fleet. ⛔ **E1–E4**

Independent of M1–M4 by design — `src/fleet/` may not import another service here, because it is the
recovery path and a fleet that needed the cdn would mean a broken cdn cannot be fixed.

---

## The shortest path to something real

The first thing that could actually be looked at, in order:

~~B1 → B2 → B3 → C1 → C2 → A2 → A1 → C3~~ — **all of M1, done 2026-09-06.**

The thing that had never happened has now happened, and it went better than the last time: 11 of 13
assertions passed on the first run against a real database. The one failure was the *test's* fault —
`fetch` silently drops a `Host` header, because it is forbidden by the fetch specification, so every
request arrived as `127.0.0.1` and the cdn correctly found no site for it. A cdn is addressed by
hostname; the test has to speak the protocol the way the proxy in front of it will.

**Next**: M2, which is where the design gets tested rather than the code. C4 → C5 → C6 — an edge
registry, sync between edges, and `gone` → rebuild. Everything up to here assumed one node, and every
assumption about the other case is currently unexamined.

One thing the catalog surfaced that has to be answered before anyone but us publishes: **part names
are a flat global namespace.** Two publishers both wanting `auth` collide, and renaming a part breaks
every site that names it. npm answers with `@scope/name`. Whatever the answer is, it is cheap now and
expensive later.

Everything else — sync, gone-and-rebuild, the api, fleet — is what makes it survive more than one
node. None of it matters until one node works.
