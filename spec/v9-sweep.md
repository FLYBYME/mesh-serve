# V9 sweep — the control site's exposed contract surface

Audit of every key in `CONTROL_CONTRACTS`
(`/home/ubuntu/code/mesh-serve/src/cdn/methods/control.ts:66-154`) against callers in
`mesh-serve`, `mesh-operator`, `flowboard`, `mesh-core`.

Read-only. Nothing was run, nothing was modified.

---

## Summary

| | |
| --- | --- |
| Keys in `CONTROL_CONTRACTS` | **35** (not 34 — `identity.register` was added at `control.ts:88` and the list's own header still says it is absent) |
| Reachable on a control site that follows `mesh-operator/HANDOVER.md` | **12** of 35 (see §"What is actually served") |
| Zero callers anywhere — no part, no mesh-serve source, no test | **7** |
| Called only internally over the broker inside mesh-serve | **11** |
| Actually called by a part over HTTP | **6** |
| No stated justification for exposure | **10** with nothing at all, 1 partial, 1 **contradicted** by its own source |
| `visibility: 'internal'` entries in the list | **0** — verified per contract below, and guarded by `test/cdn/control-site.test.ts:41-48` |
| Exercised through the real HTTP gate by any test, anywhere | **3** (`identity.register`, `identity.ticket_issue`, `identity.whoami`, all in `test/integration/api.test.ts`, none on a control site) |

Two structural facts frame everything below.

1. **The list is a ceiling, not the offer.** `src/api/api.service.ts:950,972-975` intersects
   `site.mesh` with `activeRelease.requires` (exempting `ALWAYS_GRANTED`). Already logged as
   roadmap **F16** (`spec/roadmap.md:1027-1084`). Still true; the boot log at
   `src/cdn/cdn.service.ts:280` still prints `CONTROL_CONTRACTS.length`.
2. **The list is also not the whole offer.** `surfaceContracts` adds four `approval.*` contracts
   to every site that does not already grant them (`src/api/api.service.ts:878-899`), including the
   control site. So the control site's real exposed set is `CONTROL_CONTRACTS ∩ requires` **+ 4**,
   and two of those four are advertised at the wrong gate (finding 5).

### What is actually served

`requires` is the union of every composed part's `mesh[].contracts`
(`src/builder/schema/descriptor.ts:280-281` → `src/builder/tools/import_repo.ts:100` →
`src/builder/tools/release_part.ts:145` → `src/cdn/tools/compose.ts:88,110,178`).

`HANDOVER.md:82` seeds the console onto `--host 127.0.0.1`, which is `DEFAULT_CONTROL_HOST`
(`control.ts:43`). The console declares 10 contracts (`mesh-operator/mesh.json`), `mesh-core`'s
`auth` extension declares 4, and `ALWAYS_GRANTED` adds `identity.register`
(`src/cdn/methods/grants.ts:125-129`). Intersected with `CONTROL_CONTRACTS` that is **12**:

```
identity.ticket_issue  identity.set_password  identity.whoami  identity.sign_out
identity.register      membership.find        site.find  site.get  site.seed
release.find           release.get            cdn.deploy
```

The other **23** are declared, gated, documented, in the generated CLI — and not reachable through
the api or the CLI on a cluster brought up as documented. `cdn.deploy` already computes exactly
this set as `unusedGrants` and reports it without failing (`src/cdn/tools/deploy.ts:64-66`).

`telem.ingest` is **not** in `CONTROL_CONTRACTS`, so unlike every seeded site the control site has
no exposed way to report a part that failed to mount.

---

## Per-key table

Caller legend:
- **part+HTTP** — a part calls it over the api (`cx.mesh.call` or `cx.models`)
- **declared only** — named in a `mesh.json` `contracts` array, never called
- **internal** — called over the broker inside mesh-serve
- **test only** — the only invocation is a broker call in a test
- **none** — nothing invokes it anywhere, including tests

| key | gate | callers | justified? | notes |
| --- | --- | --- | --- | --- |
| `identity.ticket_issue` | public | part+HTTP (`mesh-core/src/auth/extension.ts`), declared by console; internal handler; HTTP test `test/integration/api.test.ts:186` | yes — `identity.contract.ts:184-190` | fine |
| `identity.set_password` | **public** | CLI over HTTP (`src/cli/run.ts:323`), declared by `mesh-core` auth; **no test invokes it** | **contradicted** — `identity.contract.ts:307-310` says "`user`, not `public`" | **Finding 1** |
| `identity.whoami` | user | part+HTTP (`mesh-operator/src/console/index.ts:204`), `mesh-core` auth+identity; HTTP test `api.test.ts:167-193` | **none** — `whoamiContract` (`identity.contract.ts:365-378`) carries no comment at all | gate matches handler (401 "Not signed in") |
| `identity.sign_out` | user | part+HTTP (`mesh-core/src/auth/extension.ts:155`); broker tests `test/identity/sign-out.test.ts` | yes, but the justification argues for `public` (`identity.contract.ts:243-252`) | **Finding 6** |
| `identity.register` | operator | none from a part; HTTP test `api.test.ts:154`; `ALWAYS_GRANTED` | yes — `control.ts:73-87`, `test/cdn/control-site.test.ts:60-86` | list header at `control.ts:62-63` still says it is absent — **Finding 7** |
| `identity.grant_role` | operator | **none** — no part, no internal call, no test invocation (`test/identity/grant-role.test.ts` asserts shape only) | yes — `identity.contract.ts:416-455` | **Finding 4**. Handler re-checks operator (`identity/module.ts:639`) — stricter than gate, safe direction |
| `organization.find` | operator | internal (`src/status.ts:221`); declared by uncomposed `mesh-core` identity part; broker tests | **none** — collection comment is descriptive scoping only (`identity.contract.ts:46-50`) | **Finding 3** — unbounded cluster-wide read for an operator |
| `organization.get` | operator | test only (`test/identity/crud.test.ts:383`) | **none** | same operator exemption; no caller |
| `organization.create` | operator | internal (`control.ts:314`, `cdn/tools/seed.ts:363`); part call in uncomposed `mesh-core/src/identity/index.ts:177` | **none** | `beforeCrud` forces `ownerId` = caller (`identity/module.ts:317-320`) |
| `membership.find` | operator | part+HTTP (`console/index.ts:184` via `cx.models('membership')`) | partial — the sentence is in `control.ts:96-97`, not on the contract | F15's contract. Broker tests could never have caught it — `test/identity/crud.test.ts:49` hand-supplies `meta.organizationId`, while the api writes `meta.user.organizationId` (`api/methods/gate.ts:166-176`) |
| `membership.create` | operator | uncomposed part (`mesh-core/src/identity/index.ts:196`); broker test `crud.test.ts:92` | **none** | |
| `membership.delete` | operator | **none** — uncomposed part only (`mesh-core/src/identity/index.ts:209`); no test | **none** | **Finding 4**. The only exposed `delete` on the platform (`mesh-core/src/identity/contract.ts:220-222`), and nothing has ever run it |
| `role.find` | operator | uncomposed part (`mesh-core/src/identity/contract.ts:66`); broker test `crud.test.ts:273` | yes — `identity.contract.ts:85-89` | global collection, no tenant data |
| `catalog.declare` | operator | internal (`src/builder/tools/import_repo.ts:109`) | yes — `part.contract.ts:214-220` | handler requires a resolved tenant (`catalog/tools/declare.ts:31-36`) |
| `catalog.resolve` | operator | internal (`src/cdn/tools/compose.ts:35`); broker test `spine.test.ts:391` | yes — `part.contract.ts:259-265` | `gateFor` says `user` (`grants.ts:50`); control is stricter — safe |
| `part.find` | operator | internal (`catalog/tools/resolve.ts:80`, `builder/tools/release_repo.ts:28`, `status.ts:286`) | yes — `part.contract.ts:36-52` | |
| `part.get` | operator | **none** | covered by the collection comment | **Finding 4** |
| `partVersion.find` | operator | internal (`catalog/tools/resolve.ts:39`, `builder/tools/build_start.ts:90,93`, `builder/tools/release_part.ts:99`, `status.ts:288`) | yes — `part.contract.ts:81` | |
| `partVersion.get` | operator | **none** | thin — one clause of `part.contract.ts:81` | **Finding 4** |
| `builder.import_repo` | operator | internal (`cdn/tools/seed.ts:100`) | yes — `artifact.contract.ts:211` | requires an authenticated caller (`import_repo.ts:36-41`) |
| `builder.release_part` | operator | internal (`cdn/tools/seed.ts:131`, `builder/tools/release_repo.ts:42`) | **none** — bare `visibility: 'public'` at `artifact.contract.ts:277` | **Finding 9**. Clones and runs a build on a real node |
| `builder.release_repo` | operator | internal (`cdn/tools/seed.ts:140`) | **none** — bare `visibility: 'public'` at `artifact.contract.ts:322` | **Finding 9** |
| `builder.get_artifact` | operator | internal (`cdn/cdn.service.ts:610`) | yes — `artifact.contract.ts:331-341`, and it names the residual leak (any digest, any owner) | `gateFor` says `user`; control is stricter |
| `cdn.compose` | operator | internal (`cdn/methods/rolling.ts:125`, `cdn/tools/seed.ts:222`); broker tests | yes — `release.contract.ts:112-119` | handler requires a caller (`compose.ts:221`) |
| `cdn.deploy` | operator | part+HTTP (`console/index.ts:342`); internal (`seed.ts:312`, `rolling.ts:172`) | yes — `release.contract.ts:157-166` | checks in handler: tenant match + grant cover (`deploy.ts:44-61`) |
| `cdn.site_edit` | operator | **none** | yes — `site.contract.ts:240-254` | **Finding 4**. Handler reads through the scoped collection (`site_edit.ts:33`), which is correct |
| `release.find` | operator | part+HTTP (`console/index.ts:185` via `cx.models('release')`); internal (`rolling.ts:83`, `status.ts:334`) | yes — `release.contract.ts:41-49` | |
| `release.get` | operator | **declared only** — in `mesh-operator/mesh.json` and the generated client, never called (`cx.models` is keyed on `.find`) | same comment | **Finding 4** |
| `site.find` | operator | part+HTTP (`console/index.ts:183`); internal (`rolling.ts:166`, `status.ts:363`) | yes — `site.contract.ts:60-84`, `86-110`, `control.ts:130-140` | |
| `site.get` | operator | **declared only** | same comment | **Finding 4** |
| `site.create` | operator | internal (`cdn/tools/seed.ts:299`, `control.ts:362`); broker tests | yes — `site.contract.ts:97-101` — **but the premise is not enforced** | **Finding 2** |
| `site.seed` | operator | part+HTTP (`console/index.ts:302`) | yes — `seed.contract.ts:124-131` | requires an authenticated caller (`seed.ts:50-54`) |
| `node.status` | operator | test only (`test/fleet/fleet.test.ts`, broker) | **none** — `nodeStatusContract` (`node.contract.ts:123-133`) carries no comment | handler `requireOperator` (`fleet/methods/node.ts:306`) — matches. `grants.ts:52-62` records that this exact pair was misaligned once |
| `node.assign` | operator | test only (`test/fleet/fleet.test.ts`, broker) | **none** — `nodeAssignContract` (`node.contract.ts:83-99`) carries no comment | handler `requireOperator` (`node.ts:189`) — matches. Switches services live on running nodes |
| `node.provision` | operator | internal forwarding (`fleet/methods/node.ts:540`); broker tests | yes — `node.contract.ts:148-162` | handler `requireOperator` (`node.ts:502`) + repo allowlist |

---

## Findings worth acting on

### 1. `identity.set_password` is gated `public`, and the handler refuses an anonymous caller

The only `public` write on the control site, and three places disagree about it.

- Gate: `src/cdn/methods/control.ts:69` — `{ key: 'identity.set_password', auth: 'public' }`
- The list's rationale: `control.ts:59-61` — *"`set_password` … public, because signing in and
  claiming a provisional account are what somebody with no session does"*
- The contract's own rationale, directly above the value it annotates:
  `src/identity/contracts/identity.contract.ts:307-310` — *"`user`, not `public`: you must already
  hold a session, which for a provisional account means the password printed at first boot."*
- The handler: `src/identity/module.ts:502-507` — reads the subject from `ctx.meta.user.id` and
  throws `401 UNAUTHORIZED` *"Setting a password requires a session"* when it is absent.
- The CLI agrees with the handler: `src/cli/run.ts:318-321` refuses before prompting —
  *"Not signed in to {host}. Sign in first, then set a password."*

`checkCoarse` at `src/api/methods/gate.ts:266-267` returns `{ ok: true }` for `public` with no
caller, so the request reaches the handler and dies there. This is the failure mode
`src/cdn/methods/grants.ts:52-62` names as the one that must not happen — *"A gate can be stricter
than a handler safely; the reverse is a promise the platform will not keep"* — and it is the
node.status story repeated with the polarity that is actually unsafe to leave in a freeze.

`control.ts:59-61`'s premise is the error: claiming a provisional account is done *with* the
printed password, i.e. with a session. Nothing anonymous can call this usefully.

Not caught because nothing invokes it: `test/cdn/control-site.test.ts:57` asserts the gate is
`public` and no test ever calls the contract.

### 2. `site.create` is exposed, and its create input carries `releaseHash` and `mesh`

`site.contract.ts:97-101` earns the exposure with *"`create` is exposed: a new site has no release
yet, so there is no deploy to bypass."* That is a statement about intent, not about the schema.

- `defineCrud` builds create as `baseSchema.omit({ id, _id, createdAt, updatedAt })` —
  `node_modules/@flybyme/mesh/dist/interfaces/ICrudContract.js:204-205`
- `releaseHash` is a field of `SiteSchema` — `src/cdn/schema/site.ts:166`
- `mesh` is a field of `SiteSchema` — `src/cdn/schema/site.ts:176`

So an operator-gated `site.create` can, in one call:

- **serve a release without `cdn.deploy`'s checks.** `cdn.deploy` exists to check that the release
  belongs to this tenant and that every contract it calls is exposed by the site
  (`src/cdn/tools/deploy.ts:44-61`). `site.create` performs neither. Note the tenant check in
  particular: `deploy.ts:44-47` refuses a cross-tenant release because *"the origin is the isolation
  boundary"*, and `site.create` reaches it by naming a hash.
- **choose its own gates.** `mesh` is the exposure list; a created site may expose any
  `visibility: 'public'` contract at `auth: 'public'`. `identity.register` at `public` on a new
  hostname is the thing `control.ts:78-80` says must not exist.

This is the same argument that keeps `site.update` internal — *"`defineCrud` has no way to omit a
field from the generated update input"* (`site.contract.ts:104-108`) — applied to `create`, where
it was not made. If `cdn.site_edit` is the answer for update, `create` needs the same treatment or
the fields need to be refused in a hook.

### 3. `organization.find` / `organization.get` at `operator` is an unbounded cluster-wide read

`organizationCrud` is **global** — no `scopedBy` (`identity.contract.ts:51-59`). Every other read on
the list that was ever argued for was argued on scoping: `site.find`
(`site.contract.ts:23-29`), `release.find` (`release.contract.ts:41-49`), `membership.find`
(`control.ts:96-97`). This one has no such argument and cannot have one, because the mechanism is
explicitly disabled for the caller it is exposed to:

```
src/identity/module.ts:226-229
    const roles = isRecord(meta?.['user']) ? meta['user']['roles'] : undefined;
    if (Array.isArray(roles) && roles.includes(FIRST_OPERATOR_ROLE)) {
        return input;              // ← no narrowing at all
    }
```

Everything below that line narrows by the caller's memberships (`module.ts:230-231, 260-284`). An
operator skips it, so `organization.find` at `operator` returns every organization on the
deployment. That is the shape `site.contract.ts:16-24` calls *"the specific way [paas's] 100k lines
went wrong"*, still present.

The console's own manifest already reached this conclusion and refused to use it:

```
mesh-operator/mesh.json "//no-organization-find":
  "`organization.find` is exposed on the control site at operator and is deliberately NOT asked
   for here. It would work — identity's beforeCrud exempts an operator from the membership
   narrowing, so it returns every organization on the cluster — and that is the trap."
```

Consumer-side avoidance is not an exposure decision. Either the contract carries the sentence that
says why a cluster-wide organization index is the operator's business, or it comes off the list.
`organization.get` has the same exemption and, additionally, **no caller anywhere**.

Related and worth the same sentence: this exemption also means `organization.find` is the one read
on the list whose result set grows with the cluster, and freeze gate V15's two-organization fixture
is a prerequisite for testing it at all.

### 4. Seven keys have never been called by anything, including a test

`identity.grant_role`, `membership.delete`, `part.get`, `partVersion.get`, `cdn.site_edit`,
`release.get`, `site.get`.

This is F15's shape repeated seven times: exposed, gated, in the generated CLI
(`src/generated/cli/ToolCommands.ts`), in `mesh-operator/src/console/generated/api.ts` for two of
them, and never once invoked. Evidence per key is in the table; the two most load-bearing:

- **`identity.grant_role`** — *"nobody can ever become an operator"* without it
  (`identity.contract.ts:416-419`). `test/identity/grant-role.test.ts` asserts only that the
  contract is registered, takes an id or an email, and is exposable — it never calls the handler.
  `mesh-operator/src/console/contract.ts:140-145` records that the console's `grantRole` command was
  removed and adds *"the contract is still exposed on the control site for a caller that needs
  it."* There is no such caller in any of the four repos.
- **`membership.delete`** — the only exposed `delete` on the platform
  (`mesh-core/src/identity/contract.ts:220-222`), reached only from `mesh-core`'s `identity`
  application, which is not composed onto anything (its client is a hand-written stand-in with
  empty hashes — `mesh-core/src/identity/contract.ts:44-58`). No test anywhere invokes it.

`site.get` and `release.get` are the specific case where the promise is already published to a
consumer: both are in `mesh-operator/mesh.json` and both are emitted into
`mesh-operator/src/console/generated/api.ts:389,401`, while the console reads through
`cx.models(...)`, which is keyed on `.find` (`console/index.ts:174-176`). Declared, typed, shipped,
never called.

### 5. The exposed set is not `CONTROL_CONTRACTS`, and two extra entries are advertised at the wrong gate

`surfaceContracts` (`src/api/api.service.ts:878-899`) adds four contracts to any site that does not
already grant them, with deliberate per-contract gates:

```
['approval.check', 'user'], ['approval.decide', 'user'],
['approval.find', 'operator'], ['approval.get', 'operator'],
```

The route table honours them — `routes.push({ ..., gate: gateOf(exposed) })`,
`src/api/methods/routes.ts:128`. The descriptor does not:

```
src/api/api.service.ts:991-999
    // The same three the route table adds, so `/_describe` and a generated client agree with
    // what is actually served.
    for (const dependency of this.surfaceContracts(site.mesh)) {
        for (const exposed of dependency.contracts) {
            ...
            entries.push({ contract, auth: 'user' });     // ← declared gate discarded
```

So `/_describe` and every client generated from it advertise `approval.find` and `approval.get` at
`user`, while the route enforces `operator`. That is the too-loose-promise direction again: a caller
the descriptor says may make the call gets a 403.

It also splits the exposure hash. `describeExposure` hashes the descriptor's own gates
(`src/api/schema/descriptor.ts:163,187,199`) and `routeTable` hashes the routes' gates
(`routes.ts:136-140`). The api sends and verifies `table.exposure`
(`api.service.ts:308,313-316`) while `/_describe` etags `descriptor.exposure`
(`api.service.ts:645`). On any site where these four are added — including the control site — the
two are computed over different values.

The comment also says "three" for four entries.

### 6. `identity.sign_out` is gated `user`, against its contract's own argument

`identity.contract.ts:249-252`: *"`public`, because signing out cannot require being signed in any
more than signing in can: a caller holding an expired or already-revoked ticket must still be able
to say I am done and get the same answer as one holding a live one."* The output schema is
`z.literal(true)` for exactly that reason (`identity.contract.ts:265-271`).

Both gate tables disagree with it: `control.ts:71` (`auth: 'user'`) and `grants.ts:49` (the `USER`
set). `checkCoarse` returns 401 for `user` with no caller (`gate.ts:269-270`), and the handler reads
the token from the input and ignores the caller (`identity/module.ts:554+`). So a browser holding an
expired ticket gets a 401 on sign-out — the exact case the contract says must answer the same as a
live one.

Stricter-than-handler is the safe direction, so this is a correctness/UX defect rather than a hole.
It should be resolved in one direction before the freeze, since after it the losing side is
permanent.

### 7. `control.ts`'s own header contradicts the list

`control.ts:62-63`: *"`register` is **absent**. On a tenant site it is how people join; on the
platform's own control surface it would be a way to mint accounts on a machine you have not signed
in to."*

`control.ts:88`: `{ key: 'identity.register', auth: 'operator' }`.

The addition is deliberate and well argued at `control.ts:73-87` and
`test/cdn/control-site.test.ts:60-86` — the header is simply stale. Since the header is the document
a reader hits first, and the freeze makes the list permanent, this is worth one line.

### 8. `builder.release_part`, `builder.release_repo`, `node.status`, `node.assign` are exposed with no exposure sentence

Each carries `visibility: 'public'` with no comment justifying it, in a file where every neighbour
has one:

- `src/builder/contracts/artifact.contract.ts:277` (`release_part`) and `:322` (`release_repo`) —
  compare `importRepoContract`'s one-liner at `:211` and `getArtifactContract`'s paragraph at
  `:331-341`. These two clone a repository and run a build on a real node
  (`requirements: { memory: 2048 }`), which is the same weight as `node.provision`, and
  `node.provision` gets fifteen lines (`node.contract.ts:148-162`).
- `src/fleet/contracts/node.contract.ts:123-133` (`status`) and `:83-99` (`assign`) — no doc comment
  at all. `nodeCrud`'s reads get one at `:12-27`, `groupCrud`'s at `:44-51`, `provision`'s at
  `:148-162`. `node.assign` switches services live on running machines and is exercised only by
  broker tests.

The V9 rule is that writing the sentence is when somebody finds out. These four are the ones where
nobody has tried.

### 9. `telem.ingest` is not on the control site

`ALWAYS_GRANTED` (`grants.ts:125-129`) exists because *"the parts worth hearing from are the ones
failing to mount, and a part that fails to mount does not get to declare anything"*
(`grants.ts:112-116`). It is applied to seeded sites by `grantsFor` (`grants.ts:154`) and exempted
from the release filter by `api.service.ts:974` and `routes.ts:106`.

`CONTROL_CONTRACTS` does not include it. The exemption only prevents a listed key from being
filtered out; it does not add an unlisted one. So the control site — the one hostname an operator
reaches when a cluster is broken, and the one whose console is composed last — is the single site
on the platform that reports nothing when a part fails to boot.

### 10. Only three of the 35 are ever exercised through the real gate

`test/integration/api.test.ts` is the only place in mesh-serve that speaks HTTP
(`request()` at `:49-62`, over `node:http`). It touches `identity.register`,
`identity.ticket_issue`, `identity.whoami` and `identity.ticket_revoke`, on its own fixture sites —
never a control site. Everything else in `test/` calls the broker directly.

That is why F15 survived: `test/identity/crud.test.ts:49` supplies
`{ meta: { organizationId: 'org-alpha' } }` by hand, whereas the api writes the scope onto
`meta.user` (`src/api/methods/gate.ts:166-176`). The test exercised the collection and never the
meta the api actually builds, so `membership.find` passed its tests while refusing every real
caller.

A single HTTP fixture that boots a control site and calls each of the 12 reachable contracts once,
as an operator, would have found findings 1 and 5 and would find the next one.

---

## Things I could not determine

- Whether the **kernel** part (`@flybyme/mesh-web`) contributes anything to `release.requires`. Its
  repository is not among the four searched, so the reachable set in §"What is actually served"
  is a lower bound of 12; a kernel that declares contracts would add to it.
- Whether `mesh-core`'s `identity` application is composed onto any live site. Its own client says
  it is not (*"Regenerate it the moment this app is composed into a site"*,
  `mesh-core/src/identity/contract.ts:52-56`), and no `mesh.json` in these repos requires it — so
  `organization.create`, `membership.create`, `membership.delete` and `role.find` are treated above
  as having a declared-but-uncomposed consumer.
- Whether the exposure-hash split in finding 5 produces a user-visible failure. The client generator
  writes `auth: 'public'` uniformly and by design (`src/api/client-cli.ts:114-129`, roadmap D4), so
  a generated client's exposure hash never matches a site's anyway; the verification at
  `api.service.ts:313` fires only when a client sends the header. The gate discrepancy between
  `/_describe` and the route table is not conditional and is the part I am confident about.

---

# The other half: what happened when they were run

*Added 2026-09-10. Everything above is static — the header says so: **"Read-only. Nothing was run."**
Its own summary line closed with **"exercised through the real HTTP gate by any test, anywhere: 3"**,
and that number was the finding. This section is the rest.*

The live two-tenant cluster, three accounts, every hostname:

| account | roles | organizations |
| --- | --- | --- |
| `operator@node.invalid` | `operator` | Platform **and** Flowboard Inc, owner of both (V8b) |
| `owner@flowboard.test` | none | Flowboard Inc |
| `loner@nowhere.test` | none | **none** |

Two passes. Every parameterless read (`find`, `whoami`, `check`, `status`, `resolve`) called for
real, and every write **probed with an empty body** — which separates the two halves of a refusal
without performing one: `403` means the gate refused, `400` means the gate *passed* and only the
input was wrong. Nothing was created, changed or deleted by the sweep.

## The isolation held, everywhere

Worth stating first because it is the thing that would matter most if it were false, and three
separate mechanisms were exercised at once — the coarse gate, the scoped read, and F22's
site-scope resolution.

- On `127.0.0.1`, the control site, **only the operator got through at all**. Both other accounts
  are `403` on all twelve reads and on every write except the three that are `public` by design.
- On `flowboard.localhost`, the tenant owner read the board and `loner@nowhere.test` got
  `400 ORGANIZATION_REQUIRED` on all seven collections — and `404 no_such_organization` when it named
  Flowboard Inc explicitly. It read a card in full that morning.
- On `console.localhost`, Platform's own console, the tenant owner is **not** refused — they get
  `200` on `site.find`, `release.find`, `membership.find` and `organization.find`, and see **only
  their own rows**: one site, five releases, their own two memberships. That is the scoped read doing
  exactly its job on a hostname somebody else owns. Whether Platform's console *should* answer a
  tenant at all is a product question and not a leak.
- The operator sees two sites on `console.localhost` and Flowboard's board on `flowboard.localhost`,
  with no header either time. That is F22, and it is the same account both times.

## What it found instead: three ways the platform refuses people it should not

| | | |
| --- | --- | --- |
| **F26** ★★★ | every error a hosted service raises becomes `500 INTERNAL_ERROR` | fixed |
| **F28** ★★ | nobody can change their own password on a seeded site | fixed |
| **F27** ★★★ | a tenant cannot write to its own application at all | logged, not fixed |

F26 and F28 are in `spec/roadmap.md` with their evidence. **F27 is the one this section exists for**,
because it is invisible to every static reading — `gateFor` is correct about each contract it was
written for, the site record is correct, the descriptor is correct, and the result is a board whose
owner may read it and change nothing.

```
flowboard.localhost, signed in as the account that owns Flowboard Inc:

  card.find      200      card.create    403
  project.find   200      card.update    403
  sprint.find    200      project.create 403
  ...                     worktree.*     403  (all nine)
```

## The method is the point

Each of F23, F25, F26, F27 and F28 was found by making a request, and none of them by reading the
source — F25 in particular had a test in this repository **asserting the broken value**, under a
comment explaining the failure it existed to prevent. The static sweep above is what said where to
look; running it is what said what was wrong.

The gap it names is still open: there is no fixture that boots a site and calls its exposed set as
more than one kind of caller. `test/integration/api.test.ts` is the closest and touches four
contracts on its own fixture sites. **A sweep is not a test** — this one ran once, by hand, against
a cluster that will be torn down.
