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

- [ ] **D9 ★★ An API token is the whole basis of the agent/person distinction, and there is no way to
      get one.** Found 2026-09-08 pointing Claude Code at flowboard's MCP endpoint.

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

      **Corrected 2026-09-09: there is a door, and it is the bootstrap socket.**
      `npx mesh identity api_token_issue --bootstrap ws://127.0.0.1:4001 --name … --userId … --roles …`
      mints one — the framework CLI reaches an internal contract over the mesh, which is exactly what
      *internal* means and not what this entry assumed. So the token path is reachable today, and
      approvals were verified end to end on one.
      What is actually missing is narrower and still worth doing: it needs the node's socket rather
      than the site, so it is an operator's laptop and not a console; it prints through the
      contract's `print`, which deliberately omits the secret, so the token has to be read some other
      way; and there is no revoke or list beside it. **The HTTP half of the divergence stands** —
      `ApiService` resolves tickets only, so a token that works over MCP is anonymous over HTTP and
      the CLI cannot use it (D10).

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
