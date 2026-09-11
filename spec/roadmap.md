# Roadmap

What it takes to bring this repository up to its own spec.

Written 2026-09-06. The spec documents describe a system; `src/` is roughly a third of one. This is
the gap, in the order the dependencies actually run.

**★** marks something that blocks several other items. **⛔** names what an item waits on.
Sizes are **S** (an afternoon), **M** (a day or two), **L** (longer, or unknown until started).

---

## Where it actually stands

*Last reconciled against `src/` and a full test run on **2026-09-08**. A row here that disagrees with
the code is the bug this section exists to prevent — see [the note on drift](#keeping-this-honest).*

| | state |
| --- | --- |
| `identity` | **built, and rewritten onto CRUD.** Seven `defineCrud` collections, `scopedBy` throughout, five contracts public as of #65. The hand-rolled store is gone. |
| `builder` | **works.** Fetches a commit, bundles with esbuild, publishes one artifact per part, caches by input hash, and refuses a part it does not own. Bytes on disk. |
| `cdn` | **serves.** Binds a port, resolves Host → site → release → artifact, generates the page per request, composes and deploys. Rolling releases re-deploy on their own. |
| `catalog` | **works.** `part` and `partVersion`, a pure resolver, immutability enforced in `publish`. |
| `api` | **serves.** `api.service.ts` gates and scopes calls from the site record; the generator (`mesh-serve client`) is one command inside it, not the whole of it. |
| `fleet` | **works.** `node.hello`/`assign`/`status`/`reconcile`/`provision`, groups, an operator gate, and a repo allowlist. All of Track E. |
| `telem` | **collects.** Browser-side reports over an injectable sender. |
| `supervisor` | **runs.** Registers and switches service entries on a node; what `node.provision` writes into. |

**503 tests across 41 files**, and the spine, durability and fleet layers each run against a real
`MeshApp` with a real mongo, a real git repository, real esbuild and a bound port.

**M1, M2, M3 and M5 are done.** What is unproven now is **M4** — a third party publishing a part
through checks that actually run — and **M6**, where every capability listed above meets a screen.

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
- [x] **A4a ★★ Identity does not persist anything.** *(done 2026-09-06)* `memoryStore()` is the
      **only** implementation of `IdentityStore` that exists, and `createIdentityModule()` defaults
      to it — so `bin/node.mjs` runs a platform whose every user, ticket, organization, membership,
      role and grant lives in one process's heap and is gone when it exits.
      Found by signing in to the first console: register, get a ticket, call successfully, restart
      the node, and the account no longer exists. Nothing errors on the way — a fresh process simply
      has no users, and a ticket issued a minute earlier is `UNAUTHENTICATED`.
      This is the reason A4 is not merely tidiness. Four other services persist through `defineCrud`
      against mongo and this one persists nowhere, so **the only service holding anything a person
      cannot regenerate is the only one with no storage**. Every other durability property in this
      repository — content-addressed artifacts, immutable versions, releases, sites — is undone at
      the login screen.
      Either A4 lands, or `IdentityStore` gets a mongo implementation first as a smaller step. The
      second is the honest interim: it is the same interface, and it stops the platform being
      dev-only. **M** (interim) · **L** (A4)
- [x] **A4 Rewrite `identity` on `defineCrud`.** *(done 2026-09-06)* All 7 record types (`user`,
      `organization`, `membership`, `role`, `grant`, `ticket`, `apiToken`) defined on `defineCrud`
      with `dependencies: []` and all CRUD actions `internal`. `membership` is tenant-scoped by
      `scopedBy: 'organizationId'`; the other 6 are global. The 8 explicit contracts stay intact
      as the public door and enforcement layer. MongoDB index names aligned with
      `Database.ensureDomainIndexes`. Verified tenant isolation on membership CRUD and unscoped caller
      login and whoami in `test/identity/crud.test.ts`. **L**
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
- [x] **A5c-i ★ `mesh.json` now carries presentation.** *(done 2026-09-06)* `description`, `homepage`,
      `license`, `keywords` and `icon` on the part; `changelog` on the version. The split held up
      exactly as written below — presentation on the `part` row, updated by every publish; identity
      and changelog frozen with the version.
      Proven on the live catalog, and the proof is the interesting part: publishing mesh-demos wrote
      ten descriptions **while refusing all ten versions as unchanged**, because `upsertPart` runs
      before the version check. Fixing a typo is a publish, not a version bump, which is the whole
      claim. A field the descriptor omits is left alone rather than cleared, so a publisher that
      knows about `description` and not `license` cannot erase a license.
      Original reasoning, kept because it is why the shape is what it is: A part
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
- [x] **B6 Who may publish.** *(done 2026-09-06)* A `partVersion` row is what a site resolves to, so whoever writes one
      can change what runs on someone else's hostname. Enforced in `catalog.publish`: caller identity is derived
      honestly from `ctx.meta.user.tenant_id`, caller with no identity is refused (401), and a part already
      published under an organization cannot be published to by another tenant (403). **M** · ⛔ B1, C1

- [ ] **B9 ★ A git server, so a push is the whole deploy.** Every step from source to a hostname is
      now an endpoint — `builder.import_repo`, `builder.release_part`, `builder.release_repo`, a
      rolling release that recomposes and redeploys itself. **The only human step left is deciding
      that a commit exists**, and that decision has already been made by the person who pushed.
      The shape: the platform hosts the repository, so a push to the default branch is an event it
      already has, rather than a webhook it has to be told about by something outside itself. That
      event calls `release_repo` for that repository, which mints versions, publishes, builds — and
      every release marked `rolling` follows, which is already built and already works in
      production (`cdn.release_rolled`, 2026-09-07).
      **Why hosting it rather than a GitHub webhook.** A webhook is the smaller change and it puts
      the trigger outside the platform: a secret to rotate, an endpoint that must be reachable from
      the internet, and a delivery nobody can replay when it is missed. Hosting the repository makes
      the push a fact the platform observed, which is the same reason the catalog holds a part's
      declaration rather than reading `mesh.json` on every build. It also answers the credential
      question that shaped `build_start` — a builder holding a token that can read any repository is
      the thing that contract was reshaped to avoid, and a repository the platform already has needs
      no token at all.
      **What it does not mean.** Not a deploy on every push: a release is composed and a *rolling*
      release chooses to follow it. A repository can be pushed to all day and change nothing that is
      serving, which is the separation between a registry and a deploy that the whole model rests
      on. And not a build on every push either — an unchanged commit is already idempotent, and a
      branch that is not the default branch should publish nothing.
      **Prerequisites, all of them already true:** versions are minted rather than read from the
      repository, so a push needs no version bump; `(partName, commit)` is the identity, so pushing
      twice is not an immutability violation; the declaration lives in the catalog, so a repository
      that edits `mesh.json` changes nothing until somebody imports it. Those three are what make a
      push-triggered build safe rather than alarming, and each was a separate day's work. **L**

- [ ] **B10 ★ Drivers: a part chosen by configuration, not by being installed.** A part is a
      `kernel`, an `application` or an `extension`, and the question is whether there is a fourth
      kind. There is a real distinction and it is not "an extension that talks to the outside":
      | | how it is selected | how many | who declares the interface |
      | --- | --- | --- | --- |
      | extension | by being in the release | one that provides each token | itself |
      | **driver** | **by a record naming it** | **one of many that could** | **somebody else** |
      An `auth` Extension provides `AUTH` and *is* the definition of what that means; installing it
      is the decision. A driver implements an interface it did not define, several could implement
      the same one, and which is used is a **deployment's** choice written in a record — the same
      shape as `site.releaseHash`: the code exists independently and something points at it.
      **The evidence it is already real:** mesh-serve has four, hardcoded. `Fetcher`
      (`methods/source.ts:23`), `CredentialFor` (`:41`), `BlobStore` (`blobs.ts:28`), `IdentityStore`
      (`store.ts`). Each is an interface with exactly one implementation, passed to a constructor in
      code — so swapping the blob store for S3, or the fetcher for a forge that is not git, is a
      code change and a redeploy rather than a record. That is the thing a driver kind would fix,
      and it is *also* the shape surfdns needs at the product level: a DNS platform talks to
      registrars and providers that differ per zone, which is one interface and many
      implementations chosen per record. This is the case, not a hypothetical.
      **What it would need**, and each is a real decision rather than a line of code:
      - **an interface declared as data**, so `catalog.resolve` can answer *which parts implement
        this*. Today an interface is a TypeScript type, which the catalog cannot see.
      - **binding**, and this is the hard half: what record names the driver, and at what
        granularity. Per node? Per site? Per zone? `node.services` is the nearest existing thing.
      - **capability**, because a driver reaches something the platform does not otherwise touch —
        a credential, a network, a disk. The extension model has `needs(...)`; a driver holding a
        registrar's API key is a bigger claim than any part makes today.
      **Do not build this yet.** It is the right shape and none of it is urgent: four hardcoded
      implementations is not painful at four, and the version below is one interface's worth of
      value at a whole part kind's worth of cost. Revisit when the *second* implementation of any of
      those four is actually wanted — that is the moment the abstraction is paid for rather than
      guessed at. **L**

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
- [x] **C4 The edge registry.** *(built 2026-09-06)* One row per running edge: id and **url**. Not
      liveness — the mesh already knows which nodes are up, and a second heartbeat beside it is two
      sources of truth that disagree during exactly the incident where it matters.
      The cdn registers itself on start and removes itself on clean shutdown; an edge that dies
      without removing its row is discovered by C5 trying to fetch and failing. Unscoped and not
      exposed: internal infrastructure for peer blob sync. **S** · ⛔ C3
- [x] **C5 ★ Artifact sync between edges.** *(built 2026-09-06)* An edge needs digest D and does not have
      it: queries registered peer edges via `edge.find`, fetches over **HTTP (`/blobs/:digest`), not the broker** —
      a kernel bundle is megabytes and the broker is for control messages. Validates incoming bytes against
      the content digest using sha256 before storage; discards corrupt responses. Coalesces concurrent misses
      in-flight via a singleflight Promise map. **L** · ⛔ C3, C4
- [x] **C6 `gone`, and rebuild.** *(built 2026-09-06)* No edge holds it → mark the artifact and partVersion
      `gone` → rebuild from the catalog's commit via `builder.build_start` authorized by `part.publisher`.
      Safe because the build is deterministic: verified that rebuilt digest equals original digest. Rebuilt
      artifact flips back to `available` and partVersion back to `built`. **This is the only durability story
      there is** — the edge disk is a cache and git is the archive. **M** · ⛔ C5, B1
- [ ] **C7 Eviction is a refcount, not a policy.** An artifact is removable when no release a live
      site names resolves to it. That makes deleting a site remove *its* composition while the kernel
      and shared parts survive — which is also the legal answer. **S** · ⛔ C1
- [x] **C8 Part CSS ships with the artifact.** *(built 2026-09-06)* A part imports a `.css` file;
      esbuild emits it into the artifact alongside `index.js`; `pageFile` collects stylesheets across
      all composed part artifacts and emits `<link>` tags in the page head.
      **Order is canonical**: kernel stylesheet first (the baseline rules), followed by part stylesheets
      in composition order (alphabetical by part ID), followed by the site's theme tokens on `:root`.
      **The scoping decision**: document-level cascade with canonical composition ordering — **no
      artificial scoping mechanism**. Rewriting CSS with digest-derived attributes would destroy content
      addressing (causing bytes to differ depending on mount or requiring preprocessors/CSS-in-JS).
      Two parts defining the same selector resolve ties via CSS source order; tokens inherit across
      all parts without Shadow DOM. **M**

- [ ] **C9 ★ A rolling release recomposes once per part, not once per repository.** Releasing
      mesh-core emits `builder.part_released` seven times, and the rolling handler treats each as a
      reason to re-resolve everything — so one `release_repo` produced **seven** compositions, six of
      them superseded within seconds of being written, and six deploys that moved nothing
      (`rolled … (0 site(s))`, 2026-09-07 23:22).
      Harmless and wrong in three ways. It writes six releases nobody asked for, which is noise in
      the one collection where every row is supposed to mean a deliberate decision. It deploys the
      site to an intermediate composition that existed for two seconds. And it made a real failure
      look routine: the first roll refused with *does not expose builder.import_repo …* — correct,
      the site had not been granted the new contracts yet — and scrolled past under six more lines.
      The fix is a debounce with the *repository* as the unit, not the part: `release_repo` already
      knows it is releasing a set, so the event it fires at the end should describe the set. That
      keeps `release_part` firing per part for the case where a part really is released alone. **S**

- [ ] **C10 ★ A kernel ships with the extensions it cannot run without.** A release names one kernel
      and a set of parts, and every part is equally optional — so a release composed with a kernel
      and nothing else is valid, resolves, deploys, and renders a blank page. The kernel needs a
      chrome to draw windows into and an auth Extension to hold a session; a page without them is
      not a smaller page, it is a broken one.
      `requiredParts` already exists and already says this — *"a kernel may declare these too. A
      kernel that ships no chrome and expects one is stating a real requirement, and the alternative
      is a bare kernel rendering nothing with no explanation"* (`schema/descriptor.ts`). It is
      resolved transitively at compose. **So the mechanism is built and the kernel does not use it**:
      mesh-web declares none, because its `mesh.json` describes a kernel with no dependencies, which
      was true when nothing else existed.
      Two ways to say it and they are not the same. `requiredParts` on the kernel's *version* makes
      compose pull them in and refuse without them, which is the existing machinery and the smaller
      change. A **bundled** set — shipped inside the kernel artifact — is a different claim: that
      those extensions are not separately versioned or replaceable, which contradicts the whole
      reason a part is its own artifact ("installing an extension is not a site rebuild"). Prefer
      the first unless there is something a page genuinely cannot boot without having *already*
      loaded, in which case say what and why, because that is a real exception to the model.
      What it needs beyond declaring: the resolver must not let a required part be omitted at
      compose, and the console should not offer to remove one. **M** · ⛔ B2

- [ ] **C11 ★ Load a part on demand, from the catalog, into a running page.** The artifact model was
      built for this and stops one step short. Parts are separately addressed, separately cached and
      separately replaced — *"installing an extension is not a site rebuild"* is the sentence the
      whole design rests on — but the **set** is fixed at compose time: the release names the parts,
      the page gets an import map generated from it, and that is what can ever run.
      The want is a button in the catalog that runs the thing it is describing. Three separate
      problems, and only the first is ordinary work:
      1. **The kernel loads a part after boot.** A dynamic `import()` of `/_a/<digest>/index.js`,
         then registering its contributions into a live registry. The registry already does this at
         mount and the pieces are re-entrant; what assumes boot is the *loader*, not the model.
         mesh-web, medium.
      2. **The page is allowed to fetch it.** `index.html` is generated per request from the
         release, so a digest the release does not name is not in the import map and cannot be
         imported. That is not an oversight — it is what stops a site being made to run arbitrary
         code — so on-demand loading needs a site to say *parts from this catalog may be loaded on
         demand*, which is a genuinely different posture from *this release is what runs here*.
      3. **Its contracts are granted, and this is the interesting one.** `cdn.deploy` refuses a
         release calling a contract the site does not expose, and the refusal is per *release*. A
         part loaded at run time has never been through that check: it would load, render, call
         something the site never granted, and get a 404 that looks like a bug in the part.
         So a loaded part needs the grant check *at load time* — the same comparison `deploy` makes,
         made per part instead of per release, with a refusal a person can read. That check is
         `release.requires` against the site's `mesh` list and it already exists; what does not
         exist is anywhere to run it that is not a deploy.
      **Order matters:** 3 before 1. Loading a part that then fails opaquely is worse than not
      loading it, and the check is the smaller piece. **L** · ⛔ C1

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
- [x] **D1 Move it out of mesh-api before mesh-api is deleted.** *(built 2026-09-06; mesh-api archived
      the same day)* `src/api/api.service.ts` in the shape below — `mountCrud` zero times, `node:http`,
      `gate.ts` and the ticket cache and revocation poller kept, express and `rest.ts`'s route table
      dropped. `test/integration/api.test.ts` and `stream.test.ts`, 22 tests.
      **Left unticked until now**, which is its own small lesson: the deadline in this item's title
      passed — mesh-api *was* deleted — and nothing noticed, because the item and the work were
      tracked in different places. **Not a port** — the shape is decided
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
- [x] **D2 ★ Routes come from the record.** *(built 2026-09-06)* Host → site → release → `mesh[]` → routes,
      exactly as the cdn resolves Host → site → artifact. Same cache, same invalidation. It makes the gate
      **per site**: one site may expose `domains.zone_find` as public while another requires `user`.
      `routeTable()` accepts `release.requires` so only required contracts are routed, omitting unused
      grants. `ApiService` and `api_describe` resolve host to site via `cdn.resolve_site` (reusing the
      sole unscoped query) and fetch the release to derive gated route tables. Cached on
      `${site.id}:${releaseHash}:${site.updatedAt}` with negative caching for unknown hosts and
      invalidated by `cdn.site_deployed` and `site.updated`. **M** · ⛔ C1, D1
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
- [x] **~~D3~~ superseded — original entry, kept for the argument it makes.** *(closed by the
      entry above, mesh v2.2.0, 2026-09-06.)* **Left unchecked for half a day after it shipped, and
      that cost something**: reading this file top-down found this entry before the closed one, so
      D3 was reported as still blocking and written into `surfdns/architecture/rules.md` as the gate
      before the third generation could start. It was not. A superseded entry must be struck through
      the moment its replacement lands — D3a's original was, this one was not, and a roadmap that
      says a shipped thing is pending is worse than one that omits it.
      The reasoning below stays because it is the clearest statement of *why*: **This is a change to
      mesh, not to the api.** The api can
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
- [x] **D4 The exposure hash.** *(built 2026-09-06)* The API reports it (`x-exposure` and `x-exposure-shape`),
      the generated client carries both gate and shape hashes, and an exposure mismatch is an immediate error
      naming the exact contract and difference rather than a confusing 404 three calls later.
      Resolved the core contradiction: releases are site-independent (C1) and cannot hold per-site gates (D2).
      Separated into two distinct hashes: `shapeHash` (gate-independent hash over contracts, methods, paths, and schemas;
      answers *is this generated client stale?*) and `exposure` (gate hash over what a site exposes and at what level).
      Releases track required contracts via `release.requires`, verified at deploy time. **S** · ⛔ D1, D2
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

- [ ] **D6 ★ `visibility: 'internal'` is not enforced anywhere but HTTP.** A `defineCrud` marking
      every action `internal` — `user` does exactly this, deliberately, and says so — is protected at
      exactly one place: `describeExposure` (`api/schema/descriptor.ts:150`) refuses to put it in a
      site's REST exposure. **Nothing consults `visibility` at dispatch.** Not `ServiceBroker`, not
      `ServiceModule`, not any middleware; the only other reader in the repository is a log line.
      So `internal` means *not routable over HTTP*, and does not mean *not callable*. Any process
      that completes the mesh handshake may call `user.find_one` and read every user row on the
      deployment, and it needs no ticket, no organization and no roles — **not forged meta, no meta
      at all.** Found by `src/bring-up.ts`, which does precisely that and works.
      Two separate holes, and the second is the one that matters: a joined peer can also *construct*
      any meta it likes, so `scopedBy` and every `requireOperator` check are assertions a caller
      makes about itself. `MESH_KEY` is therefore not one boundary among several — it is the only
      one, and a key that leaks is every collection on the platform.
      The fix is a broker-level check, because per-tool checks are what this already relies on and
      they are individually correct: a call arriving **over the network** may only reach a contract
      whose `visibility` says so, whatever meta it carries; a call from a module mounted in the same
      process may reach anything. That distinction exists in the transport and is not currently
      passed to the dispatcher. **L** · ⛔ mesh

      **Mitigated 2026-09-09 by closing the door, because the fix cannot be taken.** `mesh` is frozen
      (`mesh/docs/STABILITY.md`), so the broker-level check is not available — and the hole is only
      reachable by something that joins the mesh, so what remains is to stop doing that.

      > "Everything that the package mesh-serve provides must be managed through the api and the cli.
      > This is a must now. Nothing else."

      A node now serves a **control site** for itself (`cdn/methods/control.ts`), which is what made
      this possible: a cluster with no sites had nothing to point a CLI at, so going around the api
      was not laziness, it was the only way in. With a route to `identity.ticket_issue` on a bare
      node, `src/bring-up.ts` became an HTTP client holding a ticket, `callerFor` and
      `MESH_BOOTSTRAP_OPERATOR` are deleted, and `npx mesh … --bootstrap` is retired as a way to
      reach a cluster ([cli.md §7](./cli.md)). `publish-cli` went the same way in F6.

      **The hole itself is unchanged** — anything that completes the handshake can still assert an
      identity — and `MESH_KEY` is still the only boundary. What changed is that nothing this
      repository ships does it any more, so a key that leaks is a key an attacker must first obtain
      rather than a step in a documented workflow.

- [x] **D7 ★ `release` is exposed on an argument for safety it never implemented.** *(fixed 2026-09-07)*
      `scopedBy: 'tenantId'` is declared. Scoping it broke serving, which is the half worth
      remembering: `site` is scoped and `cdn.resolve_site` exists because a browser is anonymous,
      and `release` never grew that second door — the cdn, the api and `api.describe` all read it
      directly and every deployed page 503'd. They read it as `site.tenantId` now, which
      `cdn.deploy` already guarantees is its owner. It also fixed something that looked unrelated:
      a CRUD event's delivery scope *is* the collection's `scopedBy`, so `release.*` events had
      been reaching nobody. `releaseCrud`
      declares `visibility: { find, findOne, get, count: 'public' }` and its own comment says why that
      is safe: *"exposable now because `scopedBy` makes every generated read a read within the
      caller's own organization"* (`cdn/contracts/release.contract.ts:40`). **`releaseCrud` declares
      no `scopedBy`.** The framework has no default — an undeclared collection is unscoped
      (`normalizeUniqueKeys`: *"On an unscoped collection: all keys are global"*) — so `release.find`
      answers with every composition on the platform: which parts each tenant runs, at which
      versions, at which digests. Reachable from a browser on any site that exposes it.
      The comment is not wrong about the rule, and that is what makes it dangerous: it states the
      condition that would make the exposure safe, in the same object that fails to meet it, so
      reading the file is *reassuring*. `siteCrud` next door does declare it (line 81), which is why
      this reads as done.
      Fix is one line, plus the question it raises: `build` is unscoped too and nobody decided that —
      a build record names a repository and a commit. `artifact`, `part` and `partVersion` are
      global **on purpose** and say so; those three stay. **S**

- [x] **D9 ★★ An API token is the whole basis of the agent/person distinction, and there is no way to
      get one.** *(fixed 2026-09-09 by the control site)* Found 2026-09-08 pointing Claude Code at
      flowboard's MCP endpoint.

      `McpService` draws its central line between a program and a person by *how the caller
      authenticated*: `#resolve` tries the ticket cache, then `identity.api_token_validate`, and a
      caller that arrived on a token carries `agent`. Everything downstream hangs off that — a
      `destructive` contract refuses `caller?.agent !== undefined` and nobody else, which is
      [mcp.md §7](./mcp.md) resolved the right way: *a destructive write asks a person*, and a token
      is not one.

      **`identity.api_token_issue` is not `visibility: 'public'`, so no site can grant it**
      (`describeExposure` throws on an internal contract, by design). Nothing in `src/cli`,
      `bring-up.ts` or `scripts/` mints one. `src/identity/module.ts:673` implements it and only the
      broker can reach it. So the only credential anybody can actually obtain is a ticket — and a
      ticket is a *person*, which means an agent client pointed at a site holds a person's authority
      over every destructive call on it, exactly the case the refusal exists to prevent.

      F7 already depends on this and papers over it: `publish-cli` "now requires an API token
      credential (`--token`, `MESH_TOKEN`, or `MESH_API_TOKEN`)" — required from somewhere unstated.

      The fix is a door, and which door is the decision: a public `identity.api_token_issue` gated at
      `user` and scoped to the caller's own principal (a person mints a token for their own agent),
      or a `mesh-serve token` CLI command over the bootstrap socket (operators only, no site
      exposure). The first is what a console needs; the second is what tonight needs. **S** ·
      [mcp.md §7](./mcp.md)

      **Corrected once, then fixed 2026-09-09.**

      The first correction was that a door existed — the framework CLI over the bootstrap socket —
      and it was the wrong door. `npx mesh … --bootstrap` joins the mesh as a peer, and a joined peer
      asserts whatever identity it likes (D6). Minting a credential through the one hole the
      credential exists to close is not a bootstrap, it is the hole.

      **Fixed properly by the control site.** A node serves a site for itself
      (`cdn/methods/control.ts`), `identity.api_token_issue` is exposed on it at `operator`, and the
      CLI is descriptor-driven — so:

      ```
      mesh-serve --host 127.0.0.1:5005 identity api_token_issue \
          --name agy-1 --userId u-… --roles worker --json
      ```

      prints the token, because `--json` renders the whole answer rather than the contract's `print`,
      which deliberately omits the secret. No second command was needed: **the missing piece was a
      route, not a feature.**

      Still worth doing beside it, and small: a `list` and a `revoke`, so a token can be taken back
      without a database. **The HTTP half of the divergence is also fixed** (D11): `resolveCaller` is
      one function both services read, so a token authenticates over HTTP as well as MCP.

- [x] **D10 ★★★ No collection outside this repository could ever stream an event.** *(fixed 2026-09-09)*
      Found asking why flowboard's board did not notice rows created through its own API.

      `registryLookup` will not deliver an event it cannot narrow: it wants an explicit definition,
      then the collection's `scopedBy`, then membership of `GLOBALLY_DELIVERED`. That set is
      `part, partVersion, artifact, node, group, role` — **every name in it is defined in `src/`**,
      and joining it meant editing a file in this repository. So a published application's
      collections were undeliverable permanently, whatever they were, and the only signal was
      `/events` refusing the entire subscription: flowboard got `no module here defines it` twenty-one
      times, once per derived event, and a board that never updated.

      The refusal is right — streaming an unscoped collection means pushing every row to every
      subscriber, and *"a new collection that forgets to say what it is still fails loudly instead of
      quietly streaming to everybody"* is the correct default. What was wrong is that **the decision
      lived in the wrong repository.** It belongs to the collection that owns the data, beside
      `scopedBy`, which is where mesh 2.4.2's `defineCrud({ delivery: 'global' })` now puts it.
      `registryLookup` reads that first; the set stays as what it always described, now one of two
      routes rather than the only one. Declaring both is refused by `defineCrud`: they answer the
      same question and disagree.

      Global delivery is still not open delivery — a subscriber passes the site's gate on that event
      either way. It is only the statement that there is no *tenant* to narrow to, which for a
      single-team board is a fact. **S** · [mcp.md](./mcp.md), [managing.md](./managing.md)

- [ ] **D11 ★★ `grantsFor` promises events the runtime then refuses, and nothing notices until
      somebody subscribes.** Found alongside D10.

      Seeding derives three events per exposed collection — *"every exposed collection streams its own
      CRUD events, at the gate its `find` has"* — unconditionally. The site record for flowboard
      therefore said **21 events** and `[site] … 21 event(s)` printed on every deploy, while
      `buildEventTable` refused all 21 at subscribe time. Two numbers, both computed by this
      repository, disagreeing by everything, and the disagreement invisible until a browser opened a
      stream.

      D10 removes the cause for collections that can now declare themselves, but not the *shape* of
      it: a site can still be deployed advertising events nothing will deliver — a collection that
      declares neither `scopedBy` nor `delivery` is still derived into the grant list and still
      refused later.

      Deploy already prints `[cdn] granted but unused: …` for the mirror-image case, so the precedent
      and the place both exist. The check belongs beside it: run `buildEventTable` at deploy and name
      what will be refused, so the failure lands on the person deploying rather than on the person
      wondering why a list is stale. **S**

- [ ] **D11 ★★ `ApiService` and `McpService` are two entry paths over one exposure, and they have
      already drifted.** Raised 2026-09-09: *"i'm starting to think there might be two entry paths
      that now have to stay in sync."* They do, and they don't.
      **Renumbered from D10, which was already taken** — two entries carried that number for a few
      hours, which is exactly the kind of thing that makes a cross-reference wrong later.

      **The credential half is fixed** *(2026-09-09)*. `resolveCaller` in `api/methods/caller.ts` is
      one function both services read, and every `ApiService` door goes through it: requests,
      `/_describe`, and the event stream at both subscribe and heartbeat. Verified with a real token
      — `whoami`, a gated read and an operator-gated read all answer over HTTP where they were
      anonymous before. The stream re-resolves on the heartbeat rather than per event, so a token
      costs one broker call every few seconds per connection.

      **The ordering half stands, and is a decision rather than a task.** HTTP is coerce → gate →
      parse; MCP is coerce → parse → gate, so a site's `authorize` hook is handed unvalidated input
      on one path and validated input on the other. Both orders have a real argument: gate-first
      keeps an anonymous caller from learning the input schema, parse-first hands the hook data it
      can trust. Picking one is a behaviour change in a security-adjacent path and wants deciding out
      loud, not folded into a refactor.

      Both read the same `ExposureDescriptor` and share `methods/{gate,input,errors,routes,tickets}`,
      so the *shapes* cannot disagree. What is duplicated is the **sequence**, written out by hand in
      each, and two steps are already different:

      | | `ApiService` | `McpService` |
      | --- | --- | --- |
      | order | coerce → **gate** → parse (`api.service.ts:323-347`) | coerce → **parse** → gate (`mcp.service.ts:403-416`) |
      | credential | `tickets.resolve(bearer)` only | ticket, then `identity.api_token_validate` |

      The order matters because `executeGate` takes `input` and passes it to the site's `authorize`
      hook: **a hook is handed unvalidated input over HTTP and validated input over MCP.** A site that
      reads a field in its hook gets two different values for the same call depending on how it was
      reached, and nothing in either file mentions the other.

      The credential difference is sharper: **an API token authenticates over MCP and is anonymous
      over HTTP.** So the CLI — which is an HTTP client — cannot use the credential the platform
      issues to programs, and [D9](#) is worse than it looks: the token path is not only undeliverable,
      it is half-implemented.

      The destructive-refuses-agents rule is the *intended* asymmetry and should stay; these two are
      not. The fix is to lift the shared sequence into one function both call — `resolve caller →
      resolve scope → coerce → gate → parse → broker.call with meta` — leaving each service only its
      transport. The `meta` construction at `api.service.ts:379` and `mcp.service.ts:432` is already
      character-for-character identical, which is the tell. **M**

## Track F — Managing the platform

Found while specifying an admin console. See [managing.md](./managing.md). **None of these is a UI
task** — each is a decision about the platform's own surface that blocks any UI at all.

- [x] **F1 Every event can now be streamed.** *(fixed 2026-09-06)* All four declared no `scopedBy`,
      and an event that cannot be scoped is delivered to nobody, so the api refused every one at
      subscribe — a live view was impossible rather than unbuilt.
      Two of the payloads carried **no tenant field to scope by**, which was the real finding: they
      were written for another *service* to consume, and a service already holds the record. So
      `cdn.site_deployed` and `cdn.release_composed` gained a `tenantId`, taken from the site and the
      release row respectively so the event and the record cannot disagree, and both are
      `scopedBy: 'tenantId'`.
      `catalog.version_published` and `builder.artifact_published` are `scopedBy: 'global'`, **typed
      deliberately rather than left off**: a published version is the public fact a marketplace is
      made of, and an artifact is content-addressed so two organizations building identical source
      share one row. Omitting it would have read as *not decided yet* and behaved as *silently
      unsubscribable*.
      Two tests: that all four declare a scope, and that the two scoped ones **carry the field they
      name** — a `scopedBy` over an absent field is `unscopable` at run time with a green suite.
- [x] **F2 Things are exposable now.** *(done 2026-09-07)* Was: every CRUD action on every collection
      `internal`, so a console could not list parts, builds or sites — not refused, no route at all.
      **23 public contracts across eight domains today**: catalog `part`, cdn `site` and `release`,
      builder `artifact`, fleet `node`, identity (five, via #65), api, telem.
      The exposable set was decided per service rather than in one sweep, and `visibility: 'public'`
      means *may be exposed* — never *unauthenticated*. What remains is not this item but the
      specific holes it uncovered: **#69** nothing exposes `delete`, **#70** `artifact` and `build`
      are still entirely internal, **#71** `user`/`grant`/`role` writes are.
- [x] **F3 ★ `Role.scope` is enforced.** *(done 2026-09-06)* `schema/roles.ts` makes
      `scope: 'cluster' | 'organization'` **required**, and says why: #26 exists because `admin` meant
      organization-scoped in one place and cluster-scoped in another, so nobody could be a platform
      operator. A cluster-scoped role *is* the operator concept — the design is complete. Enforced:
      `permits` takes resolved `Role` rows and `organizationId`, granting cluster-scoped roles everywhere
      and organization-scoped roles only in an organization; write points validate against the store
      (refusing organization-scoped roles in `user.roles` and cluster-scoped roles in `membership.roleKey`).
      **Operator contracts need no new mechanism and `scopedBy` never learns about bypasses.** **M**
- [x] **F5 ★ `partVersion.kernel` is stored and never read, and a live release already violates it.** *(done 2026-09-06)*
      `publish-cli` writes the range a part was built against, with the comment *"the only thing
      standing between a stale part and a browser"*; `build_start` forwards it. **Enforced at compose time.**
      `checkComposition` checks `kernel.version` against each part's declared `kernel` range and emits
      a fatal `kernel_mismatch` problem that refuses composition if out of range. A kernel artifact's
      own absent requirement is not a mismatch, and parts published before the field existed have an
      absent range accepted without error to preserve backward compatibility. **S**
- [x] **F6 ★ `publish-cli` mints its own caller, and nothing checks it.** *(done 2026-09-06)* The CLI joins the cluster as
      a **node**, and *a node must never hold a user credential* — so the generated `ToolCommands.ts`
      passing no `meta.user`, and `site.find` refusing it, is both halves working as designed:

      ```
      $ npx mesh site find --bootstrap ws://127.0.0.1:4001
      Error: Scoped collection "site" requires a resolved "tenantId" scope, but none was
      provided in call context.
      ```

      `publish-cli` previously minted `{ meta: { user: { id: 'cli', tenant_id: args.publisher } } }` from
      a bare `--publisher` flag. Fixed: `publish-cli` now requires an API token credential (`--token`,
      `MESH_TOKEN`, or `MESH_API_TOKEN`), validates it against `identity.api_token_validate`, and derives
      the caller scope honestly from the token's organization or user memberships (`identity.whoami`).
      Calls without credentials are rejected naming `MESH_TOKEN`. An asserted `--publisher` acts as an
      optional assertion/disambiguator that must match the verified token's organization. Cross-organization
      attempts to publish another organization's part return 404 `No such part.` matching `build_start`. **M**
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
- [~] **F9 `site.image` is stored and never rendered.** *(tag emitted 2026-09-08; the field is still
      half-designed)* `page.ts` emitted `og:title` and `og:description` and no `og:image` — a site
      set the field, the tag never appeared, and nothing said so. The tag is now written, with two
      tests, and `image` joins the `Pick` in `PageInput` that had quietly excluded it.

      ~~One line in the page generator.~~ **It was not.** The schema documents `image` as *"a path
      within an artifact this release serves, so it is content-addressed like everything else"* — and
      a path into an artifact needs a digest, which the field never carries. Every other file the
      generator emits knows its artifact: the kernel's entry from `release.kernel.digest`, a part's
      from `release.parts[id].digest`. **There is no third thing an image can belong to.**

      So it is emitted as written: a site setting a URL, or a `/_a/<digest>/…` path it resolved
      itself, is served correctly today; a site setting `logo.png` and expecting the platform to find
      it is not, and there is nowhere for the platform to look. **The field needs to name a part**
      before the schema's own comment is true. Until then the comment promises content-addressing the
      generator cannot deliver, which is the more interesting half of this item and the reason it is
      not closed. **S**
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
      The single most valuable screen. **F2 is done and this is now only blocked on `build` itself
      being internal — #70.** **S** · ⛔ #70
- [ ] **F10 `defineCrud` cannot shape a create input, and this is the third time.** *(found
      2026-09-07)* `organization.create` needs `ownerId` set from the session and absent from the
      input. `defineCrud` derives its create input from the base schema, so a field required on the
      stored record is required in the input, and there is no override.

      The workaround now in `identity/module.ts` is a `beforeCrud` hook that **overwrites** whatever
      `ownerId` arrives with the caller's id. It is correct — a caller must not be able to create an
      organization owned by somebody else — but the API asks for a value it ignores, which is a thing
      somebody has to be told rather than read.

      This is the same constraint that produced `cdn.site_edit`, whose contract comment says it
      plainly: *it exists because `defineCrud` cannot omit a field from a generated update.* Twice is
      a pattern; three times is a missing feature. Two candidate answers, the first cheap:

      1. A per-action input override — `createInput: (base) => base.omit({ ownerId: true })`.
         Everything else stays generated. Belongs in mesh, not here.
      2. Accept that any collection whose create needs the session gets a hand-written tool, and say
         so in the spec so nobody keeps rediscovering it.

      **Whatever is chosen must not reach for the third answer.** The first attempt weakened
      `OrganizationSchema.ownerId` from `min(1)` to `default('')`, which silently un-answered
      surfdns#29 — an organization with no owner became constructible again.
      `test/identity/principals.test.ts` caught it. **S**
- [x] **F11 An operator could sign in to a fresh cluster and read nothing.** *(found and fixed
      2026-09-09, bringing the console up)* `identity`'s `beforeCrud` narrowed every organization
      read to the caller's **memberships**, and the first operator on a cluster holds none —
      deliberately. `ensureControlSite` says so in as many words: *an operator holds a cluster-scoped
      role, which grants everywhere and lives on the user rather than in a membership … a caller who
      needs one will be told so by the gate.* They were told, and there was no way to answer.

      Three different messages for one cause, none of them naming it:

      - `organization.find` answered `[]` on a cluster whose `platform` organization the operator
        **owns** — `ownerId` is on the row and the gate never looked at it.
      - `site.seed --org-slug platform` failed with *Duplicate value "platform" for unique field
        "slug"*: its own `find_one` came back empty, so it created what already existed.
      - `site.find` refused outright — *Scoped collection "site" requires a resolved "tenantId"
        scope* — because the operator resolved to no tenant, and the only route to one was a
        membership in an organization they could not see.

      Fixed by not narrowing for a caller holding the cluster-scoped `operator` role, which is what
      cluster-scoped already means everywhere else (F3). The roles come from the validated ticket,
      never from anything the request said about itself. **S**
- [x] **F12 The api gave a contract ten seconds and returned 500 for work that succeeded.**
      *(found and fixed 2026-09-09)* `api.service.ts` dispatched every route through the broker's
      default timeout. `site.seed` clones every repository named and bundles every part in them —
      about forty seconds here — so the caller got `500 Internal server error` while the node logged
      `seeded 127.0.0.1 → sha256:89dd6ee3…` a second later. **The run failed and the work
      succeeded**, which is the most confusing pair of outcomes available and is the exact failure
      `site.seed`'s own doc comment already warned about.

      What made it hard to see: `site.seed` raises the timeout on every call it makes *internally*,
      so every step inside it had fifteen minutes and the one dispatching it had ten seconds.

      Fixed with a generous ceiling rather than a per-contract table — mesh is frozen, so a contract
      cannot declare how long it takes, and a hand-kept list of slow ones is wrong the first time
      somebody adds work to a handler. The socket is the real bound. **S**

- [x] **F13 A console cannot list people, because `user` carries the password hash.**
      *(found and fixed 2026-09-10, starting the console's `people` view)* Every action on `userCrud` is `internal`,
      and rightly: `passwordHash` is a field of `UserSchema`, so a generated `find` returns it. There
      is no visibility setting that omits a field, which means **`user.find` can never be exposed**
      and the obvious read for a people screen does not exist. `organization`, `membership` and
      `role` are all exposable and already on the control site; the accounts themselves are the hole.

      The same shape as F10 and as `cdn.site_edit`: a generated action carries a field it must not,
      so the answer is **a purpose-built contract rather than a visibility flag** — an
      `operator`-gated `identity.people` returning id, email, displayName, roles, `suspendedAt` and
      `provisional`, and nothing else. A contract that does not have the field cannot be talked into
      returning it, which is the argument `site.contract.ts` already makes about `releaseHash`.

      **`identity.people` is that contract.** Operator-gated and checked in the handler rather than
      trusted from the site record — it is an unbounded read of every account on the deployment, and
      a gate is configuration. `search`, `role` and a bounded `limit` that reports `truncated`; a
      new `store.listUsers` on both implementations.

      `suspendedAt` and `provisional` are in the projection deliberately: they are the two facts that
      explain a person being unable to do anything, and a list without them shows a working account
      and a locked one identically. The first-boot operator is the case that proves it — it holds
      `operator` and is refused everywhere until claimed.

      7 tests. The one that matters asserts on the **keys** of a returned person, not on the absence
      of `passwordHash` by name, because the defect this prevents is a credential arriving in a field
      nobody thought to look at. **S**

      **Withdrawn 2026-09-10, the same day, by freeze gate V8 — and the projection was never the
      problem.** `identity.people` was safe. It should not have existed, for three reasons that are
      about the *capability* rather than the implementation:

      1. **The operator is a bootstrap-and-handover role.** Bring a cluster up, `site.seed` a
         hostname — which creates the organization owning it — hand it over, step out. Reading every
         account on the deployment is not part of that.
      2. **The gate was weaker than it read.** *"Checked in the handler rather than trusted from the
         site record"* is stated above as the stronger guarantee. It is not: `meta.user` is a wire
         field a joined peer fills in (**D6**), so both rest on the same assertion. It is defence
         against a misconfigured site, which is worth having and is not isolation.
      3. **It answered the wrong question.** *Who is in this organization* is `membership.find`,
         already `scopedBy: 'organizationId'`, already exposed, and bounded by construction.

      **The part of F13 that is still true is the gap**, and it is now freeze gate **V2**: a
      generated find cannot omit a column, so four purpose-built contracts exist to route around one
      missing feature. Withdrawing this one does not close it — `user.find` is still unexposable —
      and the console converting to a members view found the cost directly: **a membership names a
      person by `userId` and nothing exposed turns an id into a name**, so the screen renders ids.
      That is the first time this gap has cost a person reading a screen rather than an author
      writing a contract, and it is the strongest argument for field-level visibility yet: with it,
      `user.get` would expose `email` and `displayName` and withhold `passwordHash`, and the screen
      would simply work.

- [x] **F14 An operator console shows one organization's sites, not the cluster's.**
      *(found and fixed 2026-09-10, verifying stage 3)* `site` is `scopedBy: 'tenantId'` and mesh is frozen, so a
      caller resolves to exactly one organization and `site.find` answers within it. The operator now
      resolves to `platform` (F11), so the console works — and on a cluster with one organization
      *the platform's hostnames* and *the cluster's hostnames* are the same set, which is why the
      screen looks right and the header is already lying. It says **"What this cluster serves"**.

      Two doors again, and `cdn.resolve_site` has already made this argument twice: serving is not
      managing, and managing your own is not administering everyone's. Listing every site on the
      cluster is a third operation and wants a third contract — `operator`-gated, unscoped, on the
      cdn, reading the collection directly the way the serving path does.

      **`cdn.all_sites` is that contract**, and `tools/all_sites.ts` is the second confined bypass of
      scoped CRUD in the service — `resolve_site` being the first, and its doc the standard this one
      had to meet. The invariant here is not *cannot enumerate*, since enumerating is the point. It
      is: the operator role is checked **before the read**, the query is built from three named
      fields so nothing a caller sends reaches the repository as structure, and the result is bounded
      and says when it was cut short.

      `SiteRepo`'s doc named exactly one permitted holder; it now names two, which is the only honest
      way to widen a stated invariant.

      7 tests, on a **two-organization** fixture. That is the whole design of the test file: on a
      single-tenant fixture every assertion passes against a scoped read, which is precisely how the
      bug shipped looking correct. **S**

      **Withdrawn 2026-09-10, the same day, by freeze gate V8. The diagnosis was right and the fix
      was the wrong half of it.**

      Everything above about the header is correct: it said *What this cluster serves* over a scoped
      read and was already lying. What does not follow is the next paragraph. **The claim was the
      defect, not the query** — the answer was to make the sentence true, which costs one string, not
      to widen the read, which costs a contract, a second bypass of scoped CRUD, and a permanent
      cluster-wide enumeration on the exposed surface.

      Three things were wrong with it beyond that:

      - **Cluster inventory is a fleet question and this put it on the cdn.** *What is on this box* is
        real during an incident, and the caller is the box's own shell rather than a browser holding
        a ticket. `node.status` is operator-gated and already exists for it.
      - **It invented a second answer to a settled question** — `{ sites, truncated }` where the
        platform already had `find(limit)` and `count`. See freeze gate V1: whatever `find` versus
        `list` is decided to be, a newcomer does not get to disagree with it.
      - **`SiteRepo` named two permitted holders and is back to one.** *"The only honest way to widen
        a stated invariant"* is true as far as it goes, and the honest thing before widening one is
        to ask whether the second holder should exist. It should not have.

      The console now reads `site.find` and says *N hosts in <organization>*. The two-organization
      fixture this item introduced is the part worth keeping, and it is promoted to freeze gate
      **V15**: it is a prerequisite for auditing the operator bypasses at all, because on a
      one-organization cluster a scoped read and an unscoped one are indistinguishable.

- [x] **F15 ★ `membership.find` was exposed, gated, documented, and refused every caller that ever
      made it.** *(found and fixed 2026-09-10, building the members view for freeze gate V8)*

      ```
      Scoped collection "membership" requires a resolved "organizationId" scope,
      but none was provided in call context.
      ```

      **The scope was resolved. It was spelled wrong.** mesh resolves a scoped read by looking on
      `meta.user` for the field the collection named, then for its snake_case spelling
      (`DatabaseMiddleware.ts:35`). The api wrote `tenant_id` and nothing else, so
      `scopedBy: 'tenantId'` found it via the fallback and **`scopedBy: 'organizationId'` found
      nothing** — and `membership` is the one collection on the platform scoped by anything other
      than `tenantId`.

      Fixed in **one place**: `callerMeta(caller, scope)` in `gate.ts` builds `meta.user` for both
      `api.service.ts` and the two call sites in `mcp.service.ts`, writing the resolved scope under
      both names. They are one value — the gate resolves exactly one scope from the caller's own
      memberships — spelled the two ways the collections spell it. **Not a widening:** the value is
      still `outcome.scope`, so a caller-supplied organization still cannot reach it. The alternative
      was renaming `scopedBy` on `membership`, which is a schema change to work around a lookup this
      side controls.

      4 tests, and they assert the **field names** rather than that a scope is carried. A test of the
      latter would have passed against the broken version, because it was carried.

      **What this actually is, is F14's lesson one layer down.** `membership.find` sat in
      `CONTROL_CONTRACTS` at `operator` from the day the control site existed. It was in the
      exposure descriptor, in the generated client, and in the freeze gate's own text as the
      recommended alternative to `identity.people` — *"already `scopedBy: 'organizationId'`, already
      exposable"* — written by somebody, twice, who had never called it. Exposure makes a contract a
      promise and **nothing had asked whether this one was true.**

      That is precisely the case freeze gate **V9** exists for: every exposed contract needs a
      sentence saying why it is safe to expose, and writing that sentence is when somebody finds out
      it does not work. A second sweep is worth its own item: which other exposed contracts has
      nothing ever called? **S to fix, and the sweep is V9.**

- [ ] **F16 ★★★ `CONTROL_CONTRACTS` is a ceiling, not the exposed set — and following the documented
      bring-up costs an operator two thirds of the platform.** *(found 2026-09-10, first hour of
      freeze gate V9)*

      Measured on two live nodes rather than read off the code:

      | | contracts at `/_describe` |
      | --- | --- |
      | a control site with **no release deployed** | **38** |
      | the same host after `site.seed` put the console on it | **15** |

      Both logged `[cdn] control site "127.0.0.1" updated — 34 contract(s) for an operator` at boot.
      **The log is false on the second one and has been since the first release was deployed.**

      The mechanism is deliberate and correct: `api.service.ts:949` reads `activeRelease.requires`
      and skips any entry of `site.mesh` the deployed release does not name. A site should expose
      what it serves and nothing more — least privilege at the composition boundary. With no release,
      `required` is `undefined` and no narrowing happens, which is why this was invisible: **an
      unseeded control site is the only one that offers the control surface.**

      What is actually exposed is **`CONTROL_CONTRACTS ∩ release.requires`**, and nothing says so.
      Every comment in `control.ts` reads as though the list is the offer — *"36 entries long"*,
      *"added to `CONTROL_CONTRACTS` must not need somebody to remember to re-seed"* — and the boot
      log states a number that is a ceiling.

      **The operational consequence is the serious part.** `DEFAULT_CONTROL_HOST` is `127.0.0.1` and
      HANDOVER.md's bring-up seeds the console onto `--host 127.0.0.1`, so following the instructions
      replaces the control surface with the console's manifest. Unreachable afterwards, through the
      api or the CLI:

      ```
      node.status  node.assign  node.provision          the fleet, entirely
      builder.*    catalog.*    cdn.compose  site.create  the build path
      organization.*  role.find  membership.create/delete  identity.grant_role
      ```

      `mesh-serve --host 127.0.0.1:5005 node status` answers *control does not offer "node status" to
      you*, correctly. And the standing rule is that this package is managed **through the api and
      the CLI, nothing else** — so a cluster brought up as documented cannot be fully operated by any
      sanctioned route.

      Three candidate fixes, not chosen here:

      1. **Seed applications onto a hostname that is not the control host.** Costs nothing, changes
         one line of the bring-up, and leaves both sites whole. Probably right.
      2. **Exempt the control site from the `requires` narrowing.** Makes the control surface
         dependable and makes one site special, which is the kind of exception this codebase spends
         its comments arguing against.
      3. **`site.seed` refuses the control host** unless told otherwise. Turns a silent reduction
         into a refusal, which is the direction every other decision here goes.

      Whichever, **the boot log must stop printing a number it does not know.** It has the site
      record and not the release; the honest line names the ceiling as a ceiling.

      This is the case for freeze gate **V9** and it arrived in its first hour. The item's second
      question — *has anything ever called it?* — found `membership.find` (F15). Its first question —
      *why is this safe to expose?* — cannot even be answered for these 23, because **they are not
      exposed**, and the file that lists them says they are. **M** · surfdns freeze gate V9

- [x] **F17 ★★★ `site.create` is exposed, and its generated input carries `mesh` — so a caller
      defines a hostname's entire exposure surface and every gate on it.** *(found 2026-09-10 by the
      V9 sweep; verified against the live descriptor rather than read off the schema. **Fixed the
      same day:** removed from `CONTROL_CONTRACTS`, with a test that it stays out. Nothing outside the
      process had ever called it — `site.seed` creates sites in-process, with the checks.)*

      What `/_describe` actually advertises for `site.create` on a control site:

      ```
      host  application  tenantId  api  releaseHash  mesh  theme  policy
      title  description  canonical  image  indexable
      ```

      `defineCrud` derives a create input from the stored record and omits only id and timestamps, so
      three fields nobody would put in a hand-written contract are in this one:

      - **`mesh`** — the site's exposed contract list *and the gate on each*. A caller who writes it
        chooses the platform's authorization for that hostname. Exposing `identity.grant_role` at
        `public` on a new host turns an operator-gated capability into an open one. `describeExposure`
        still refuses `visibility: 'internal'`, so `user.find` cannot be reached this way — that check
        holds and is the reason this is a widening rather than a breach.
      - **`releaseHash`** — what the site serves, with none of `cdn.deploy`'s checks that the release
        belongs to this tenant and that every contract it calls is one the site exposes. **This is the
        exact field `cdn.site_edit` exists to keep out of an exposed `site.update`**, and it is
        reachable through create.
      - **`tenantId`** — whose site it is. `scopedBy` narrows reads; whether it overrides this on a
        write is **unverified** and is the first thing to check.

      **Nothing sanitises any of it.** The cdn service mounts no `beforeCrud` and no `afterCrud` —
      verified, there are none in the file. And `site.create` sits in `CONTROL_CONTRACTS` between
      `site.find` and `site.seed`, both of which carry paragraphs explaining themselves, **with no
      justification at all.**

      This is the recurring shape at its most consequential: *a generated action carries a capability
      it must not, and no gate can subtract a field.* Four purpose-built contracts already exist for
      exactly this — `identity.sign_out`, `cdn.site_edit`, `cdn.resolve_site`, and the withdrawn
      `identity.people` — and `cdn.site_edit`'s own doc makes this argument about this very field.
      **Freeze gate V2 is the mechanism that would end it; this is the strongest single case for it.**

      Wanted, and it is small: `site.create` comes off the control surface, and `site.seed` — which
      already creates sites, with checks — is the door. If a bare create is genuinely needed, it is a
      purpose-built contract taking `host` and `application` and nothing else. **S** ·
      surfdns freeze gate V9, V2

- [x] **F18 ★★ `identity.set_password` is exposed `public` and its own contract says it must not be.**
      *(found 2026-09-10 by the V9 sweep. **Fixed the same day:** gated `user`. Confirmed first that
      the claim path always has a session — the bring-up signs in with the printed password and then
      sets one — and that `checkCoarse` admits a provisional caller to this action before the level is
      checked.)*

      Three statements, two of which disagree:

      | | says |
      | --- | --- |
      | `identity.contract.ts:307-310` | *"`user`, not `public`: you must already hold a session … Public would let anybody set anybody's"* |
      | `cdn/methods/control.ts:69` | `{ key: 'identity.set_password', auth: 'public' }` |
      | `identity/module.ts` | throws 401 without a session |

      **It fails closed**, because the handler is the one that decides, so this is not a hole. It is
      the surface lying about itself, and `grants.ts` states the rule it breaks: *a gate stricter than
      the handler is safe and the reverse is a promise the platform will not keep.* This is the
      reverse.

      The fix is not simply to tighten it. `set_password` is what claims a provisional account, and a
      person doing that has the printed password, so they can sign in first — which the bring-up
      already does. Confirm that is the only path, then gate it `user` and delete the contradiction.
      **S**

- [x] **F19 ★★★ A mounted service's query strings were never coerced, because it brings its own
      zod.** *(found and fixed 2026-09-10, on the first two-tenant cluster)*

      ```
      GET /api/cards?limit=5      →  400  limit: Expected number, received string
      GET /api/releases?limit=5   →  200                         (same node, same second)
      ```

      `coerceToSchema` recognised field types with `instanceof z.ZodNumber` against the zod this
      repository imports. A service loaded with `--service` is built from **its own copy** —
      flowboard's contracts come from `flowboard/node_modules/zod`, the same version and a different
      module instance — so every `instanceof` was false for every field it declared, and nothing was
      coerced. Its lists worked only because the browser never sends `limit`. **Pagination sends it on
      every call (freeze gate V4)**, so this would have broken every external service's lists the day
      paging landed.

      Every test passed throughout, because every schema in them came from the one copy of zod the
      tests import. The fix reads `_def.typeName` — the discriminant zod itself switches on, the same
      string in every copy — through type predicates rather than casts. The regression test builds its
      schemas from zod's CommonJS build, which is a genuinely separate class set, and first asserts
      that it is, since a test using the same copy would prove nothing.

      **Worth checking elsewhere:** any other `instanceof z.*` in this repository that can see a
      schema a mounted service built. **S**

- [x] **F20 ★★ `/_describe` advertised every surface contract at `user`, and the route enforced
      something else.** *(found by the V9 sweep, confirmed and fixed 2026-09-10)*

      `surfaceContracts` declares `approval.find` and `approval.get` at `operator`, deliberately — a
      queue row carries the frozen input of an agent's parked call. The route table enforced that. The
      descriptor pushed `auth: 'user'` for all four. So flowboard, signed in as its own tenant owner,
      called `GET /api/approvals` because its descriptor said it could, and got **403**. A descriptor
      that disagrees with its routes is the one thing it must not be: it is what a generated client is
      built from.

      Now the descriptor uses the gate the surface declares. Note what it does **not** settle:
      flowboard's queue view still cannot be read by a tenant member, now honestly. Whether an
      organization's own members should see its own approval queue is a product question for flowboard,
      and the answer is not to loosen the gate on every site. **S**

- [x] **F21 ★★★ No tenant member can open the event stream, so no tenant has ever had live
      updates.** *(found 2026-09-10, signing in to flowboard as its own owner. **Fixed the same day**,
      by the first of the two options below: each event is checked at its own gate, the stream carries
      the ones the caller passes, and the rest are named in `x-events-omitted` and as a
      `subscription.omitted` first event. A caller who passes none is still refused with that
      refusal's status. Fixed with it: the heartbeat re-check used `table.events[0]`, which on a real
      site is an operator-only approval event — so an admitted tenant would have been cut off at the
      first heartbeat. It now re-checks against an event the caller was admitted to.)*

      ```
      GET /api/events  (flowboard.localhost, as owner@flowboard.test)
      403  approval.created requires the operator role. (subscribing to approval.created)
      ```

      The stream is opened only if the caller passes **every** event's gate, and that is deliberate —
      `api.service.ts` argues *"a caller who could receive some events gets a refusal rather than a
      stream that silently omits the rest."* Defensible on its own. It meets `surfaceContracts`, which
      adds `approval.created | updated` at `operator` to **every site**, and the product is that no
      non-operator anywhere can subscribe to anything. Flowboard's cards, sprints and comments stream
      to nobody but the operator.

      Invisible on every cluster before today, because the only account that ever signed in was the
      operator — which is freeze gate V15's whole argument, arriving on schedule.

      A decision, not a patch. Either the stream subscribes a caller to the events it may receive and
      says which it omitted (the refusal argument answered by *saying so* rather than by refusing), or
      the platform's surface events stop being operator-only on tenant sites. **M** · surfdns freeze
      gate V15

- [x] **F22 ★★ A caller in two organizations reads as signed out.** *(found 2026-09-10, same cluster.
      **Fixed the same day**, in three parts. **The mechanism:** a request arrives on a hostname whose
      site belongs to an organization, and when the caller is a member of it that is what they mean —
      so the scope resolves to the site's organization without a header. It chooses among the caller's
      own memberships and cannot add one. The rule moved out of `bin/node.mjs`, where it had never been
      tested, into `api/methods/scope.ts`. **The copy:** a scoped read with no scope, for a signed-in
      caller, is re-worded from mesh's 401 into `400 ORGANIZATION_REQUIRED`, which a browser shows as
      a bad request naming the header instead of *"You need to sign in"*. An anonymous caller keeps
      the 401. **The CLI:** `--in-organization <id>` sends the header, for acting in an organization
      other than the site's.)*

      Seeding a second tenant made the operator an owner of both organizations (the caller becomes the
      owner — freeze gate V8b). From then on, every scoped read the console makes with no
      `x-organization` header fails:

      ```
      401  Scoped collection "site" requires a resolved "tenantId" scope, but none was provided
      ```

      and the console renders that 401 as **"You need to sign in"** — to somebody who is signed in.
      With the header naming Platform the same read returns both of its sites.

      Two defects in one. **The copy**: a 401 for an ambiguous scope and a 401 for no session are
      different failures, and a screen that says *sign in* to a signed-in person sends them to fix the
      wrong thing. **The mechanism**: a part has no way to name its organization — the CLI cannot send
      the header either — so a person in two organizations has no working console at all. Fixing V8b
      removes this case for the operator and leaves it for every real person in two organizations.
      **M** · surfdns freeze gate V8b

- [x] **F23 ★★ F22 fixed the api and not the MCP surface.** *(found and fixed 2026-09-10, scoping
      flowboard's own collections — `flowboard B1`.)*

      `McpService` calls the same `executeGate` and was handed no `siteScope`, so the fix for *a
      caller in two organizations reads as signed out* covered browsers and left agents exactly where
      they were — and an agent has nowhere to put an `x-organization` header, so there was no
      workaround either. Four call sites in `api.service.ts` were wired and the fourth file was not,
      which is what an omission at a call site looks like.

      Invisible until now for the reason F22 itself was: every account on every cluster belonged to
      exactly one organization, so `resolveScope`'s *only membership* branch answered before the site
      was ever consulted. It became load-bearing the day flowboard's collections stopped being global
      — before that an agent dispatching a card read an unscoped collection and needed no scope at
      all.

      **The fix.** `ExposureDescriptor` carries `siteScope`, because a descriptor is all `McpService`
      is given — a second source for *which site is this* is how the two get to disagree, which is the
      argument `agentRoles` already made. Outside both hashes: who owns a hostname is not part of what
      the hostname exposes, and folding it in would report every generated browser client stale the
      first time a site changed hands.

      **Tested by reading the source**, in `test/api/scope.test.ts`. `McpService` builds an HTTP
      server in its constructor and its gate calls sit behind `#private` methods, so there is no seam
      — and a rule nothing checks is precisely how four call sites got wired and a fifth did not.
      Verified by removing one `siteScope` and watching it fail. **S**

      **Verified live 2026-09-10** on the two-tenant cluster, and this is the observation that
      matters: the operator owns *both* organizations, and `card_find` over MCP on
      `flowboard.localhost` returned Flowboard Inc's card with no header anywhere. If the site's
      scope were not consulted, `resolveScope` would answer *authorized, no scope*, `meta` would
      carry no `organizationId`, and the now-scoped collection would refuse it. Returning the row
      **is** the proof.

- [ ] **F24 ★ Seeding another organization's site from the control site fails with "No such part."**
      *(found 2026-09-10, running flowboard's B1 migration.)*

      `seed` posts to the control site, so F22 now resolves the caller's scope to **Platform** —
      correctly, that is whose hostname it is. `ensureOrganization` then takes that scope when the
      call names no organization, and every catalog write runs as Platform. `catalog.declare` refuses
      a part whose `publisher` is somebody else, deliberately and with a deliberately unhelpful
      message: *"Not found, not forbidden: which organization publishes a part is not something an
      unrelated caller gets to confirm by probing."*

      **The refusal is right and the message is aimed at the wrong thing.** Three attempts read as a
      broken catalog — naming all three repositories, then only flowboard's, then guessing — when the
      answer was `--org-slug flowboard`. Before F22 the same mistake produced
      `organization_unknown`: *"A site belongs to an organization and this caller resolved none. Name
      one."* That message was correct and is now unreachable, because a scope always resolves.

      The fix is not to loosen `declare`. It is that `site.seed` knows the host it was given, and a
      host that already exists names its tenant — so seeding an existing site from another
      organization's control plane should say *"flowboard.localhost belongs to Flowboard Inc; pass
      --org-slug flowboard"* before it clones anything. **S**

- [x] **F25 ★★★ On a scoped collection only `created` was ever delivered. Every `updated` reached
      nobody.** *(found and fixed 2026-09-10, on the live cluster, minutes after flowboard's
      collections became scoped.)*

      `scopedBy` names a field **on the row**, and mesh does not put the row in the same place for
      all three verbs (`DatabaseMiddleware`): `created` emits the row itself, `updated` emits
      `{ id, patch, item }`, `deleted` emits `{ id }`. `decideDelivery` read the field off the top
      level, found nothing on an update, and answered `unscopable` — which is *delivered to nobody,
      operators included*, because a broken payload is deliberately not broken only for other people.

      **The symptom is a list that only grows.** A row created elsewhere appears; the same row
      edited does not. Measured, not reasoned: an open `/events` subscription on `flowboard.localhost`
      received `card.created` in full and nothing at all for `card.updated` on the same card, seconds
      apart.

      It was never flowboard's. It applies to every scoped collection here — `site`, `release`,
      `approval`, `membership` — so **an approval *request* streamed and its *decision* did not**,
      which is the queue this platform tells agents to poll. It hid behind two things: the lists
      people actually watch (`part`, `node`, the catalog) are `GLOBALLY_DELIVERED`, where the payload
      is never consulted at all; and `test/api/surface.test.ts` **asserted the broken value** —
      `{ field: 'tenantId' }` for both verbs — under a comment explaining that the failure it existed
      to prevent was a stream that "connected and stayed silent forever".

      **The fix is one line and `readScope` already supported it**: it walks a dotted path, so an
      update is `item.<field>`. `registryLookup` keys on the verb, which it already had in hand.

      **`deleted` cannot be fixed from here and now says so.** `{ id }` is the whole payload; the row
      is gone and nothing names its owner. mesh would have to emit the scope and mesh is frozen — so
      a scoped collection's delete is refused *by name, with its own sentence*, and appears in the
      deploy log and in `x-events-omitted` rather than as a subscription that connects and starves.
      A client wanting live removals re-reads. Freeze gate **V6** is where the general fix belongs:
      `defineCrud` taking the row scope and the delivery scope separately.

      Verified live after the fix, and by an integration test that opens a real stream and asserts
      the `updated` frame arrives — checked by reverting the one line and watching it fail. **S**

---

**F26–F28 came out of one thing: running the exposed surface instead of reading it.** V9's sweep
audited all 35 control contracts and says so in its own header — *"Read-only. Nothing was run"* —
and closed with *exercised through the real HTTP gate by any test, anywhere: **3***. On 2026-09-10 the
rest were called, on the live two-tenant cluster, as three accounts: the platform operator, a tenant
owner with no platform role, and an account belonging to no organization. Every parameterless read,
then every write probed with an empty body, where `403` means the gate refused and `400` means the
gate passed and only the input was wrong.

The isolation held everywhere. What it found instead was three ways the platform refuses people it
should not.

- [x] **F26 ★★★ Every error a hosted service raises reaches its caller as `500 INTERNAL_ERROR`.**
      *(found and fixed 2026-09-10.)*

      `toHttpError` asked `error instanceof MeshError`. A `--service` is a separate npm package with
      its own `node_modules/@flybyme/mesh`, so the class it throws is a different object and the
      answer is always no. Measured: flowboard's `project.git_info` refusing
      `Either "id" or "repoPath" must be provided` — a `ClientError`, status 400 — arrived as
      `500 { error: 'INTERNAL_ERROR', message: 'Internal server error' }`, sentence removed.

      **So a hosted application could not tell its own users anything.** Every validation message,
      every *that is not yours*, every *already exists*, flattened into one 500 — and a 500 is what a
      client retries. It is the same defect as **F19** (zod's `instanceof` across copies, which would
      have broken every paged read) and takes the same fix: read the structure, not the identity.

      **The structure is deliberately narrow**, because the opposite failure is worse than a 500 —
      this function decides whether a thrown message reaches the internet, and a thrown message may
      carry a connection string. A candidate must be an `Error` with **both** a non-empty string
      `code` and an integer `status` in 400–599. A `MongoServerError`'s `code` is a number, node's
      `ENOENT` has no `status`, an undici failure has neither. `test/api/errors.test.ts` asserts each
      of those still comes back opaque. **S**

- [x] **F28 ★★ Nobody could change their own password on any seeded site.** *(found and fixed
      2026-09-10, same sweep.)*

      `identity.set_password` is a write, matches none of `gateFor`'s read patterns, and fell to the
      default — `operator`. So flowboard's own owner, signed in to their own site, got 403 on their
      own password, and the only account that could change it was the cluster operator.

      The contract says so itself, in the comment directly above its own visibility: *"the input has
      no id precisely so the caller **is** the subject."* There is no version of this an operator
      does on somebody else's behalf. It joins the `USER` set, and `test/cdn/gate-for.test.ts` now
      pins every exception in that table rather than leaving them to be re-derived. **S**

- [x] **F27 ★★★ A tenant cannot write to its own application.** *(closed 2026-09-10 by F30 stage 3, verified on a live cluster.)* *(found 2026-09-10, same sweep. Not
      fixed: it is a change to what `gateFor` means, and that is the site owner's decision.)*

      On `flowboard.localhost`, signed in as the account that **owns Flowboard Inc**, every write is
      403: `card.create`, `card.update`, `project.create`, and all nine worktree gates. The board is
      readable and unusable. The only account that can move a card on it is the platform operator.

      `gateFor` ends in `return 'operator'`, and its justification is sound for the contracts it was
      written against — *"everything that changes what runs on a hostname: composing, deploying,
      releasing"*. It is applied to **every** contract on every site, including a hosted
      application's own, where "changes what runs on a hostname" is not what a write means at all.
      A card is not a deployment.

      **The one thing that lowers a write today is an agent role map**, and that is upside down:
      `grantsFor` drops a contract to `user` when a release's `agent` part names it, so whether a
      *person* may add a card depends on whether an unrelated agent part was composed. Even then it
      is partial — `flowboard-agent`'s `planner` names `card.create` and nothing names `card.update`,
      so with the agent part composed a tenant may create a card and still not move it.

      **The shape of the answer — settled 2026-09-10, and it was already in the repository.** Three
      candidates were written here (a domain-based default; per-contract gates in the site record; an
      application declaring the gate it wants). All three are workarounds for a question `gateFor`
      cannot answer, and the reason it cannot is that **it is handed a key and nothing else**. It has
      to guess what a contract does from how the string is spelled.

      There is no need to guess, because **the permission name and the contract key are the same
      string**. `permits(roles, grants, 'card.update')` asks a question that needs no classification
      table: does any role this caller holds carry a grant covering `card.update`? A contract nobody
      has granted is refused — fail-closed, without knowing what it does. That is `gateFor`'s
      instinct with the guesswork removed.

      **The evaluator exists.** `identity/schema/roles.ts` is a full role-and-grant system: roles as
      records, grants as rows, `grantCovers` patterns, `cluster` vs `organization` scope, deny by
      default. It is not a sketch — it opens by naming this exact mistake (*"surfdns compiled `public
      | user | admin` into its source"*) and it has its own test file. Nothing in the request path
      calls it. See **F30**, which is this item's real cause; F27 closes when F30 does.

      `gateFor`'s default must stay `operator` for this repository's own domains, and under F30 it
      does — by an operator role that holds those grants, rather than by a fallthrough.
      **M** · surfdns freeze gate V16: this decides what a site's `auth` level means, so it belongs
      in the freeze rather than after it.

      **Closed 2026-09-10.** `grantsFor` now emits `permission: <key>` instead of `auth: 'operator'`
      for a contract that falls through `gateFor` in a domain this repository does not define. Only
      the fall-through moves: a `user` read stays a read and a role-named contract stays where the
      agent-role branch put it, so nothing that worked stopped working.

      Measured on `flowboard.localhost`, as the account that owns Flowboard Inc and holds no platform
      role:

      | | before | after |
      | --- | --- | --- |
      | `PATCH /cards/:id` | 403 | 404 *(gate passed; that card does not exist)* |
      | `POST /projects` | 403 | 400 *(gate passed; empty body)* |
      | `POST /sprints` | 403 | 400 |
      | `POST /worktree/dispatch` | 403 | 400 |
      | `POST /worktree/merge` | 403 | 400 |

      And the half that matters more — a signed-in account belonging to **no** organization is still
      refused every one of them, 403. The gate did not loosen; it started asking a question that has
      an answer.

      The before column is worth keeping because it shows why this was not a tidying-up. `card.create`
      was `user` and `card.update` was `operator`, and the difference was not a decision anybody made:
      `card.create` is named by `flowboard-agent`'s `planner` role and `card.update` is not. **Whether
      a person could move a card depended on whether an unrelated agent part had been composed.**

- [x] **F29 ★★★ Changing a password did not end a single session, and nothing consumed a revocation
      at all.** *(found and fixed 2026-09-10, writing the fixture F27 said was missing.)*

      Two halves, each independently enough to break it, and the second is the one that had been
      written down and never wired.

      **The source.** `identity.set_password` appended a revocation row and stopped.
      `ticket_validate` decides on `isLive(ticket)`, which reads `revokedAt` on the **ticket row**
      and knows nothing about the revocation log — so a password changed *because it was believed
      compromised* left every session holding the old one working until it expired days later.
      `identity.ticket_revoke` did it correctly five lines away, marking each live ticket and *then*
      appending the row; the two never shared a path. `set_password`'s own comment promised the
      outcome at length — *"leaving the old sessions alive is exactly the case where that response
      does nothing … The caller's own ticket dies too"* — which is F25's shape exactly: a comment
      stating a guarantee nothing implements, with every test around it green.

      **The consumer.** `api/methods/revocations.ts` is the correctness half of auth §3.1, opens by
      explaining why the event cannot be the mechanism — *"`TCPTransport.publish` … at-most-once …
      not late, never"* — and defines `revocationPoller` for exactly that. **Nothing constructed it.**
      Nothing subscribed to `identity.ticket_revoked` either. So the ticket cache's TTL was not a
      backstop, it was the whole of it: every API instance served a revoked ticket for up to two
      minutes after learning nothing, from a component built to make sure it learned.

      **Fixed at both ends.** `revokePrincipal` in identity is now one path used by `set_password`
      and `ticket_revoke`, because the row and the marks answer different questions and both are
      needed — the marks are what `ticket_validate` reads, the row is what `revocations_since` serves
      to an api already holding a cached positive. `ApiService` starts the poller (pull, for
      correctness) and applies `identity.ticket_revoked` from its existing wildcard subscription
      (push, for latency, so signing out is immediate on the node that heard rather than within a
      poll interval).

      **What found it** is worth recording, because it was not a hunch: writing an integration test
      that changes a password and asserts the old ticket stops working. Three tests in
      `test/identity/sign-out.test.ts` now say it, checked by reverting the one line and watching one
      of them fail. **S**

      *An incidental correction to my own reporting: I first measured this as "signing out does not
      sign you out", and that was wrong — the probe sent `{}` to a contract whose `token` is
      required, so nothing was revoked and the 400 was correct. Sign-out always worked. Changing a
      password never did.*

- [ ] **F30 ★★★ The authorization system is built, tested and unreachable: nothing in the request
      path calls `permits`.** *(found 2026-09-10, tracing what a `permission` gate would actually
      evaluate. The parent of F27, and the fifth instance of this repository's recurring shape.)*

      **What exists.** `identity/schema/roles.ts` is a complete role-and-grant model, and it is not a
      sketch — it is 200 lines of decided design with reasons attached:

      - `RoleSchema` — a role is a **row**: key, name, scope, description, builtin.
      - `GrantSchema` — a row per (role, contract), *"because the interesting queries run the other
        way — who can call this — and because two administrators editing different roles must not
        write the same document."*
      - `grantCovers(pattern, contract)` — `post.*` covers `post.list` and not `postal.list`.
        Deliberately no `*`: *"a role that can call everything is one nobody has to think about, and
        thinking about it is the point."*
      - `RoleScopeSchema` — `cluster` vs `organization`, **required and enforced**, because `admin`
        meaning two different things is surfdns issue #26 (F3).
      - `permits()` and `surfaceOf()` — deny by default, grants only ever add, *"a system where a
        role could remove a permission is one where nobody can answer what can this person do
        without evaluating order."*
      - `BUILTIN_ROLES` — `public`, `authenticated`, `operator`, with `operator` added because the
        platform had checked for a role that was never a record.

      Its opening line names the mistake it was written to end: *"Roles are records, not an enum —
      mesh-web spec/auth.md §5, decided. **surfdns compiled `public | user | admin` into its
      source.** That cannot survive identity being a base for other projects, because every
      project's roles are different."*

      **What calls it.** In `src/`, `permits()` has exactly one caller: the handler of
      `identity.permits`, at `identity/module.ts:714`. `identity.permits` has **zero callers** in
      `src/`, `test/` or `bin/`, and is not in `CONTROL_CONTRACTS`, so it is not exposed to be
      called. `test/identity/roles.test.ts` exercises `permits` directly, in isolation, and passes.

      **What the request path does instead.** `checkCoarse` (`api/methods/gate.ts:249`) switches on
      the four-value enum the file above was written to replace, and `isOperator` is
      `caller.roles.includes('operator')` — a raw string compare, not a grant lookup. So the enum
      mesh-serve's own schema calls a mistake is still the thing that decides every request.

      **And the seam meant to bridge them is unevaluated.** `Gate` has two kinds; `permission` takes
      an arbitrary key (`dns.write`, `identity.invite`) that *"the site's `authorize` hook evaluates
      in the caller's scope"*. The hook actually installed, `membershipAuthorize`, destructures
      `{ caller, requestedScope, siteScope }` and never reads `permission`, then returns
      `resolveScope(...)` — so a permission-gated contract passes the coarse gate on *is anyone
      signed in* and is waved through. **`permission: 'dns.write'` behaves exactly like
      `auth: 'user'`.** Not currently reachable, because no site declares a permission entry and
      `grantsFor` only ever emits `auth` levels. The irony is that the *no-hook* path fails closed
      and loudly (`NO_AUTHORIZE_HOOK`, *"a misconfigured deployment must fail closed"*); it is the
      configured path that does not check.

      **The fix**, and it is a wiring job rather than a design one: `executeGate` resolves a
      `permission` gate by asking identity, `membershipAuthorize` evaluates it with the caller's
      roles and scope, and `gateFor`'s fallthrough stops being a guess about a string. F27 falls out
      of this: `card.update` is refused because no role grants it, not because the key did not match
      a regex.

      **Two things to decide while wiring, neither yet chosen:**

      1. **Role inheritance.** `roles.ts` has none. Without it `admin` cannot be *`user` plus these*
         and every shared grant is copied. paas's v1 `roles` service had `inherits` with recursive
         resolution — worth porting, and if it is, it needs the cycle guard that version lacked: A
         inherits B inherits A recurses without a visited set.
      2. **Where grants are stored and who may write them.** A grant is data, and data is editable by
         whoever can write the collection. A tenant granting themselves `**` ends the isolation V15
         measured. The write path must be scoped and subset-checked — *a role may only grant what its
         organization already holds* — which is the "may only tighten" rule from F27's third
         candidate, applied to grants instead of contracts.

      **M** · surfdns freeze gate V16, with F27.

      **Stage 3 landed 2026-09-10**, closing F27 — see its entry for the measured before and after.
      What stays open:

      - ~~**Reads are still `auth: 'user'`.**~~ **Done the same day.** Every contract in a foreign
        domain is now answered by a grant, read or write, and the decision is made *before* the
        agent-role lowering rather than after — so a role-named read and a role-named write get the
        same answer instead of one of each. `public` is the one exception and stays one: the calls a
        signed-out browser makes in order to sign in cannot be behind a grant, because holding a
        grant requires the session you do not have yet. Measured on `flowboard.localhost`:
        `GET /cards` answers **200** to the owner and **403** to a signed-in stranger, where before
        the stranger reached the collection and was stopped only by having no scope to resolve.
        `console.localhost` is unchanged — a platform read is still `user`.
      - **A role definition is global, and `owner` is one row.** So a grant on `owner` is a grant
        for every organization's owner. It is bounded twice — a contract is reachable only on a host
        whose site exposes it, and a `scopedBy` collection confines every row to the caller's own
        organization — and the ceiling's rule 2 is what keeps it from being bounded *only* by those.
        **Not verified on a cluster**: the case needs two sites owned by two different accounts, and
        `organization.create` makes the *caller* the owner while `resolveScope` correctly refuses an
        operator scoping into an organization they do not belong to, so the fixture is more than a
        probe. Whether role definitions should be per-organization is the real question underneath
        and it is unanswered.
      - ~~**`installGrants` creates grants for roles it never creates.**~~ **Fixed before the reads
        moved, because the reads are what would have made it bite.** `permits` skips a held key it
        cannot resolve — deliberately, so deleting a role does not take every membership naming it
        out of service — and the cost of that leniency is that a grant on an undefined role is
        inert, refusing the caller with nothing to say why. `installGrants` now calls
        `identity.role_upsert` for every role it is about to grant to, organization-scoped, skipping
        `owner` because that ships with identity and is not a part's to redefine. Third instance of
        F32's shape, this one in code written the same day and found by writing the note about it
        rather than by anything failing — because nothing fails; it just does not work.

      **Stage 1 landed 2026-09-10**: `inherits` on `RoleSchema`, `expandInheritance`,
      `inheritanceProblem`, and `identity.role_upsert` to call them. Both rules are refused at write
      time and honoured again at read time — a row can predate a rule, and the read path must not
      escalate on one. `permits`/`surfaceOf` now take a named `RoleWorld` rather than positional
      lists, so the role table cannot be left out: an optional one would have made inheritance
      forgettable, and a caller that forgot would get an answer wrong only for roles that inherit,
      silently. 24 tests in `roles.test.ts` (was 13). Stages 2 (seed grants from the manifest) and 3
      (the `gateFor` flip) are what remain, in that order — flipping first would refuse everything on
      a site seeded before stage 2 ran, which is flowboard B1's two-deploy shape for the same reason.

- [x] **F32 ★★★ Every organization owner held a role that was not a record.** *(found and fixed
      2026-09-10, starting F30's stage 2. The third instance of one omission, and the file that
      documents the first two is the file it was missing from.)*

      `roleKey: 'owner'` is written by `transferOwnership` and `reownOrganization` — **seven call
      sites across both stores** — and nothing ever created the `owner` role. `BUILTIN_ROLES` was
      `public`, `authenticated`, `operator`. So the role every tenant owner holds did not exist.

      **Why it hid, twice over.** `createMembership` validates that a `roleKey` exists and is
      organization-scoped, and would have caught it on the first call — but the ownership paths write
      the membership document directly and never go through it. And the read side is **lenient by
      design**: `resolveRoles` skips a key it cannot resolve, so that deleting a role does not take
      every membership naming it out of service. That leniency is right, and it is what made this
      silent — an owner resolved to *no role at all* and was denied, and a denial for want of a
      record is indistinguishable from a denial by policy.

      Measured before the fix, which is the whole finding: with an explicit grant of `card.update` to
      `owner`, `permits` answered **false**.

      **And it was already worked around in a test.** `test/identity/module.test.ts`'s `whoami` case
      calls `store.upsertRole({ key: 'owner', … })` by hand, because its scenario does not work
      otherwise — a test creating the missing row while nothing in production did. Same shape as F25,
      where a test asserted the broken value.

      Fixed by adding `owner` to `BUILTIN_ROLES`, **organization-scoped** — the half `operator` is
      not, because ownership is a fact about a person's place in one organization rather than
      standing across the deployment. Getting that backwards is surfdns #26.

      **This is why F30's stage 2 could not have worked.** The gate hook resolves a caller's
      organization role from the membership and hands it to `permits`; for every owner that string
      was `owner`, and `permits` would have dropped it. Any grant seeded against `owner` would have
      done nothing, and the seeding would have looked correct. **S**

- [ ] **F31 ★ `npm run typecheck` is red on master, and `npm test` does not run it.** *(found
      2026-09-10 while landing F30's stage 1.)*

      Two errors, neither new and neither mine: `test/cdn/control-site.test.ts:105` reads `.auth` off
      `ExposedContract`, which is a union that may instead carry `permission`; `test/cdn/page.test.ts:23`
      builds a release literal without `agentRoles`, which is required. Both are in test files, which
      is why they are invisible: `npm test` is `vitest run`, and **vitest transpiles without
      typechecking**. So the suite is green and the compiler is not, and the two disagree silently.

      The gap is not the two errors. It is that `tsconfig.json` covers `src/**` only and the config
      that covers `test/**` is a *second* file (`tsconfig.check.json`) run by a *different* npm
      script. Anyone who reaches for `npx tsc --noEmit` — the obvious thing — typechecks half the
      repository and is told it is clean. I did exactly that today and had a signature change break
      seven tests at run time that the real check had already caught.

      **Wanted:** `npm test` runs the typecheck, or CI does, so red is red. Then fix the two. **S**

## Track E — Fleet

**All four done.** See [fleet.md](./fleet.md). `test/fleet/fleet.test.ts` — 27 tests, each E-item
asserted under its own id so the track cannot quietly come undone.

- [x] **E1 `node` and `assignment`.** *(done)* A node joins, says *my name is x, what should I run?*,
      and the fleet only ever answers. It never starts a process — something else always does — which
      is why one mechanism covers a laptop and a cluster.
      **A node's identity is its hostname, not a transient node id**, which is what makes a reboot a
      reconnection rather than a new machine. Groups landed with it: a node's services are the union
      of its own and its groups', and a group edit converges its members *by event*, without anybody
      calling `node.reconcile`.
- [x] **E2 The observed half.** *(done)* `node.status` answers what a node is running and what it is
      connected to, for peers as well as itself, and **captures supervisor errors distinctly** — a
      mount that failed reads as failed, not as absent. A desired-state system whose observed side is
      optimistic is worthless.
- [x] **E3 Two nodes may not claim one name.** *(done)* A second live node claiming an already-live
      hostname is refused. Without it, a singleton assigned to both is split-brain with no error
      anywhere.
- [x] **E4 Nothing in `src/fleet/` imports another service here.** *(done)* Enforced by a test that
      reads the source, not by a convention. It is the recovery path: if fleet needed the cdn, a
      broken cdn would mean you cannot fix the cdn.

**Arrived with the track and not in it:** `node.provision` — clone a repo at a **pinned ref** onto a
node and register it with the supervisor. Refuses a mutable branch (`main`, `master`), refuses a repo
absent from the allowlist, refuses a caller without the operator role, is a no-op at the same ref,
and forwards over the broker when the target is a peer. It is how a node gets code at all, so E1's
*"it never starts a process — something else always does"* now names something real.

---

## Milestones

Tracks say what is left. These say **when it becomes usable**, and each is defined by something that
becomes demonstrably true rather than by a count of items closed.

**Four of six are done: M1, M2, M3, M5.** Written when none of them were, and when every one was
gated on the same thing — *nothing here has ever run.* That sentence stood for one day.

The two left divide cleanly. **M4** is whether a stranger can publish *into* this safely; **M6** is
whether a stranger can *operate* it at all. Neither blocks the other. M6 is the one with a person on
the end of it, and it is the one that is next.

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

**A1 · A6 · B3a · C2a · C3** all closed by it.

~~**mesh-web A9.1c** is *not* — the generated boot module still calls a `start()` the kernel does not
have, so the page loads and the parts fetch, and nothing boots.~~ **Closed on both sides**, and it
had been for a day when this paragraph still said otherwise: `mesh-web/src/kernel/start.ts:157`
exports `start(composition)` with 16 tests, and `src/cdn/methods/page.ts:265` emits the import and
the call against it. *A cross-repo item is done when both repositories say so, and neither of them
finds out by itself* — see [architecture/roadmaps.md](https://github.com/FLYBYME/surfdns) in the
surfdns repository.

**Why it was first**: everything after it is about surviving something, and until one node serves one
page there is nothing to survive.

### M2 — It survives losing a disk ✅ *2026-09-06*

*An edge is a cache and git is the archive.* Kill an edge's storage, restart it, and the site still
serves — either because another edge had the bytes, or because the artifact went `gone` and was
rebuilt from the catalog's commit.

~~**C4** the edge registry · **C5** sync between edges · **C6** `gone` and rebuild~~ — **all of M2, done 2026-09-06.**

This is the one that makes it a platform rather than a demo, and it is already *designed* to be
cheap: builds are deterministic, so several edges rebuilding at once converge on the same digest and
the duplicate work is harmless. All four durability scenarios proven in `test/integration/durability.test.ts`.

### M3 — Calls are gated and scoped ✅ *2026-09-06*

*A site exposes contracts and the API refuses what it should.* Host → site → release → routes, with a
caller's organization resolved and applied.

~~**D1** move the api out of mesh-api~~ · ~~**D2** routes from the record~~ · ~~**D3** scope reaching `defineCrud`~~ · ~~**D4** the exposure hash~~ · ~~**A4** identity rewritten on CRUD~~

**D3 is the milestone.** Until it lands, *never expose an unbounded find* is a discipline — and a
discipline is exactly what paas had.

### M4 — Somebody who is not us can publish a part

*The marketplace point.* A third party publishes a version, a site composes it, and every check that
protects the site from it actually runs.

⛔ **B4** contract verification at build time · **B5** policy on the version · ~~**B6** who may publish~~
· ~~**F6** publish-cli credential~~ · ~~**A5c-i** descriptions~~ · **D5d** the client generated by the cdn
· **D5a** the generator moved to mesh-web · **A5** unique indexes on natural keys

Also the point at which **part names being a flat global namespace** stops being a note and becomes a
migration.

### M5 — A node joins and is told what to run ✅ *2026-09-07*

*The standard way to run a service anywhere.* ~~**E1 · E2 · E3 · E4**~~ — all four, with
`test/fleet/fleet.test.ts` asserting each under its own id.

A node says *my name is x, what should I run?* and is answered; it reports back what it actually
mounted, **including what failed to mount**; a second node cannot claim a live hostname; and the
recovery path is enforced by a test that reads the source rather than by a convention.
`node.provision` arrived with it, so a node can be handed code at a pinned ref and never a branch.

Independent of M1–M4 by design — `src/fleet/` may not import another service here, because it is the
recovery path and a fleet that needed the cdn would mean a broken cdn cannot be fixed.

**It landed without being noticed**, which is the reason [Keeping this honest](#keeping-this-honest)
was written: the track that closed it still read *"shape decided, nothing built"* a day later.

---

### M6 — The platform is operated from a browser, by somebody who is not us

*Everything a person does to this platform, they do on a page.* ⛔ **surfdns#59, #61, mesh-operator**

The point M1–M5 were building toward, and the one that is now the only thing between here and
somebody else running this. Every capability exists; almost none of it has a screen.

**What already works, and is the reason this milestone is reachable rather than aspirational.** The
loop closed on 2026-09-07: `import_repo → release_repo → compose → deploy`, every step an endpoint,
versions minted by the platform, and a release marked `rolling` re-running the last two on its own.
A part released now reaches a hostname with nobody typing anything. That was six manual steps in the
morning.

**What it needed. Two of four closed on 2026-09-07:**

- ~~**Create a site.**~~ **Done.** `site.create`, `group.create` and `group.update` were exposed for
  weeks with no control anywhere; the folded operator app calls all three. The platform can now add a
  hostname to itself instead of every screen being a tour of one site somebody made with a script.
- ~~**Manage people.**~~ **Partly.** #65 exposed the identity reads and `membership.delete`, and
  mesh-operator has a people app. It still **cannot list people** — `user` reads are internal, which
  is #71 — so the app named after them shows organizations and memberships and not accounts.
- **Edit what a site exposes**, from `_describe` rather than a JSON textarea — including the two
  things only the platform knows: which grants nothing uses, and which contracts the release calls
  that the site has not granted. The second is a refused deploy shown *before* the deploy.
- **See it working.** A slow call that says so, a boot with stages, a failure that surfaces without
  the console open. Forty seconds of silence after a click is the single most common experience of
  this platform today. The vocabulary cannot express it yet — mesh-core **U2** and **U3**, tracked as
  #74.

**And one wall that is new, because exposing things found it:** **nothing can be deleted.** Until
#65, no collection exposed `delete` at all; `membership.delete` is the first and only one. A site
with a typo'd host is permanent from a browser, and `host` is globally unique. That is #69, and it
is now the largest single gap between here and this milestone.

**The test:** hand somebody the URL and nothing else. They sign in, add a site, expose what it needs,
release a part into it, and watch it go live — without a terminal, without ssh, and without asking
which flags to pass. If any step needs a person who knows the internals, that step is the milestone.

**Not in it:** a git server (B9), on-demand part loading (C11), drivers (B10). Each is real and each
is a way of *not* finishing this one.


---

## The shortest path to something real

The first thing that could actually be looked at, in order:

~~B1 → B2 → B3 → C1 → C2 → A2 → A1 → C3~~ — **all of M1, done 2026-09-06.**

~~C4 → C5 → C6~~ — **all of M2, done 2026-09-06.**

The durability story holds: an edge wiping its cache or joining cold retrieves missing blobs from
peers over HTTP (`/blobs/:digest`), detects and rejects corrupt bytes before writing to storage, and
falls back to marking `gone` and deterministically rebuilding from git when all edge copies are lost.

~~D1 → D2 → D3 → D4 → A4~~ — **all of M3, done 2026-09-06.** Calls are gated, scoped, and exposure-verified.

~~E1 → E2 → E3 → E4~~ — **all of M5, done 2026-09-07.** A node joins, is told what to run, reports
what it actually mounted, and can be handed code at a pinned ref.

**Two left, and they are not in sequence.** M4 is *can a stranger publish into this*; M6 is *can a
stranger operate it*. Neither blocks the other, and M6 is the one with a person on the end of it.

**Next**: **M6** — the surface exists and almost none of it has a screen. The three named holes are
**#69** nothing can be deleted, **#70** builds are invisible, **#71** the people app cannot list
people; **#74** is the vocabulary those screens would be built out of.

Then M4, whose remaining blockers are all about trusting a stranger's code: **B4** contract
verification at build time, **B5** policy on the version, **D5a/D5d** the client generated by the
cdn, **A5** unique indexes on natural keys.

---

## Findings from outside this repository

**`flowboard` (2026-09-07), the first package to run its own connected mesh node instead of living
in `mesh-serve/src/*`, hit two real gaps rather than just B10:**

- **`ApiService` cannot be reused standalone.** It resolves `Host → site → release` and validates
  tickets through `identity.*` — the platform's shared multi-tenant gateway, not a server a package
  can point a port at for its own six collections. A package that wants "mesh-serve for the server"
  without joining the shared fleet has to write its own small HTTP router calling `broker.call`
  directly (see `flowboard/src/server/api.ts`). Worth deciding on purpose whether `ApiService` should
  eventually support a "single-tenant, no site record" mode, rather than every standalone package
  reinventing this router.
- **`mesh-serve client` cannot generate a client for a package's own self-hosted contracts.**
  `resolveContracts()` (`src/api/client-cli.ts`) populates `globalContractRegistry` via
  `await import(pkg)` where `pkg` is the string named in `mesh.json`'s `mesh[].package` — which only
  works when the contracts live in an *installed dependency* (mesh-auth importing
  `@flybyme/mesh-serve` is the real case this was built for). A package defining and consuming its
  own contracts in one repo cannot name itself there: Node's package self-reference only resolves
  when the *importing* file is inside that package's own tree, and `client-cli.js` lives inside
  `@flybyme/mesh-serve`'s own install. The descriptor/emit internals (`describeExposure`,
  `emitClient`, `ExposeEntry`) also aren't part of this package's public `exports`, so a workaround
  script outside this repo can't reuse them either. flowboard's frontend client
  (`src/app/generated/api.ts`) is hand-written and clearly labeled as a stand-in because of this —
  not a shortcut taken lightly. Fixing this for real means either exporting the descriptor/emit
  functions publicly so a local script can build its own descriptor from locally-imported contracts,
  or teaching `client-cli.ts` to accept a relative/local path alongside a package name.

---

## Keeping this honest

**A decision made in the document where the work is happening does not propagate back to the list of
open questions by itself.** mesh-web's roadmap wrote that down about two of its own gating decisions;
on 2026-09-08 the same thing had happened here at four times the scale — a completed Track E still
reading *"shape decided, nothing built"*, F2 open with 23 public contracts shipped, a stands table
naming a `fleet` of three `.gitkeep` files, and **two different items both called F9**, because the
second was appended to the end of the file rather than into the track it belonged to.

So, three habits, none of them optional:

1. **An item is closed in the roadmap by the change that closes it**, in the same commit. Not in a
   log, not in a conversation.
2. **A new item is inserted into its track and takes the next free id in that track.** Appending to
   the end of the file is how F9 got used twice, and ids here are quoted from three other
   repositories.
3. **The stands table carries the date it was last reconciled**, so a reader can tell stale from
   wrong.
