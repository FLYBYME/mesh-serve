# Roadmap

Written 2026-09-15, after rebuilding mesh-serve's own CLI on real generated clients and then, live,
hand-running a fresh install through it. That second part is what actually produced everything below
— every item here was found by using the thing, not by reading it. Nothing here is settled; the
**Open** sections are live disagreements-with-myself as much as they are plans.

---

## Done — every `z.date()` field rejected a real HTTP request, always, for anyone

Found live: `identity.membership.create --joinedAt 2026-...` over HTTP (the CLI, or a plain `curl`)
failed with `Expected date, received string`. Root cause: `z.date()` requires an actual JS `Date`
instance -- JSON has no date type, so *every* date-typed field, called over HTTP with the only thing
HTTP can carry (a string), was broken, for anyone, always. It read as fine all session because every
prior date-setting call (`identity.service.ts`'s bootstrap, `composeConsole.ts`) went through a
direct broker call with a real `new Date()` already in hand -- this was the first time a date field
went out over the wire at all.

Checked for the same pattern elsewhere rather than patching just the one field that got hit: 9
occurrences across `user.ts`/`apiToken.ts`/`membership.ts`/`ticket.ts`, all `z.date()`, all the same
gap. All switched to `z.coerce.date()` -- accepts a string or a number over the wire and a real
`Date` unchanged for every existing direct-broker-call site, so nothing already working needed to
change to keep working.

---

## Done — `serve.artifact` had the same unexposable-CRUD gap repo/part/composition already had

Found live, exposing the catalog domain for real CLI use: `serve.artifact.find` refused with `"is
not a public contract"` even at `role: 'operator'`. `artifactCrud`'s `visibility: {}` meant nothing
on the collection -- find, get, count, all of it -- was reachable over HTTP for anyone, ever, the
exact same gap already found and fixed for `serve.repo`/`serve.part`/`serve.composition` earlier this
session. Fixed the same way: reads public, writes stay internal behind the validated
`requestBuild` tool. `api.localhost` now has the full catalog domain exposed at `role: 'operator'`
(`serve.repo`/`serve.part`/`serve.artifact`/`serve.composition`/`serve.api`/`serve.cdn`'s create/find
actions, plus `serve.part.start`/`.stop`) so the whole org/api/site/repo/part/build/compose/deploy
workflow is drivable from `mesh-serve`'s own CLI, not just from a script.

---

## Done — `kind: 'service'`: a mesh ServiceModule as a real part, loaded by a running node

The old Supervisor/Fleet system (`src/supervisor/`, `src/fleet/`, moved into mesh-serve from `mesh`
itself, then dumped into `src-dump/`/`test-dump/` in the September 11 rewrite and never rebuilt) is
**not** what this is. Explicit decision: all new, nothing restored -- the old design predates the
current `serve.api`/`serve.cdn`/`serve.repo`/`serve.part` model entirely, and reusing it would mean
adapting code built for a domain model that no longer exists.

What got built instead, reusing everything already proven this session:

- `serve.part.kind` gains `'service'`, alongside kernel/application/extension/driver/theme --
  same `repoId`/`path`/`entryPoint` fields, no new collection.
- `buildService` (parallel to `buildPart`/`buildKernel`) bundles for `platform: 'node'` instead of
  `'browser'` -- no CDN step, the output never leaves this machine's own artifact store, and
  `@flybyme/mesh` is always marked external rather than bundled (the loaded module needs to observe
  and be observed by the *same* broker instance running it, not a bundled, disconnected copy).
  `@flybyme/mesh` being external only works if it's actually resolvable from the artifact store's
  location, which isn't inside any node project -- fixed with one symlink at the artifact store's
  own root (`ensureArtifactNodeModules`), resolved via `import.meta.resolve` rather than
  `createRequire` (the package's own `exports` map has no "require" condition; resolving it as
  CommonJS fails outright even though the real ESM import works fine).
- `serve.part.start`/`serve.part.stop`: explicit only, never automatic on a successful build (the
  same deploy/build separation `serve.cdn.deploy` already has). `start` imports the latest
  successful build and calls the framework's own `broker.registerModule` -- confirmed earlier this
  session that this already handles being called after a broker has started
  (`if (this.isStarted && module.onStart) { await module.onStart(this); }` in `mesh`'s own
  `ServiceBroker`). `stop` calls the real, existing `broker.unregisterModule`. Neither contract takes
  a `nodeID` -- targeting a specific node is `ctx.call`'s own job (the `nodeID` call option, routed
  against the mesh's real node registry), not a second way to say the same thing in the contract's
  own input.
- Deliberately no persisted "is this running" state anywhere. In-memory only, per node
  (`src/catalog/methods/services.ts`), because a database flag survives exactly the crash that makes
  it wrong; asking a node directly (or finding it absent from the registry) never can lie the same way.

Verified live end to end against a real, dependency-free throwaway service: build succeeds, `start`
imports it and the mesh-level contract it declares becomes really callable over HTTP once exposed,
a second `start` correctly refuses ("already running on this node"), `stop` unregisters it for real
(confirmed by the exact same call then failing), and restarting it again works.

Found and fixed along the way: calling an exposed contract with nothing currently backing it
anywhere in the cluster (concretely: right after `stop`) threw a plain `Error`, not a `MeshError`, so
`api.service.ts`'s catch-all gave a bare, undetailed 500 -- a real, previously-invisible gap, since
nothing had ever stopped a service before this existed. Now mapped to a proper 503 carrying the
framework's own clear message.

---

## Done — the builder can now build a part with a real npm dependency

Tried to verify `serve.part.wants` actually gets populated from a repo's `mesh.wants.json` at build
time (mesh-operator now has a real one; nothing had ever registered mesh-operator itself as a
`serve.part` and built it to find out). The build failed before getting anywhere near that:
`mesh-operator/src/console/generated/api.ts` imports real `zod` (this session's own regenerated,
real-zod client), and the builder's ephemeral `git clone` had no `node_modules` at all -- `zod` was
neither bundled (nothing installed it) nor external (nothing provides it at runtime the way the
kernel provides `@flybyme/mesh-web`). `esbuild` failed outright: `Could not resolve "zod"`.

Fixed the general way, not with a blessed-package allowlist: `ensureRepoCheckout` now runs `npm ci`
(or `npm install` when there's no lockfile) in the checkout the moment there's a `package.json`,
reusing that install across builds of the same repo exactly the way the git checkout itself is
already cached. An ordinary npm dependency is bundled by esbuild the ordinary way the moment it can
actually resolve it -- no special-casing `zod` or anything else.

Reverified against mesh-operator's real repo: the `zod` resolution error is gone. The build now
fails on a different, already-known, pre-existing error (`src/console/index.ts` importing
`consoleApi`, a name the old generator produced that the new one doesn't) -- the console port
itself, still not started, unaffected by this fix.

**`readWants` itself is confirmed correct** -- retested against a trivial throwaway repo with a real
`mesh.wants.json` and no npm dependencies (so the original gap couldn't get in the way): built
successfully, and `serve.part.wants` came back as exactly `["identity.whoami", "serve.cdn.find"]`,
matching the file byte for byte.

---

## Fixed — a real security bug: two identity contracts were exposed with no gate

Found live, reported by a person testing the deployed page: `GET /api/organizations` answered 200
with real data and no `Authorization` header at all. Traced to `composeConsole.ts`'s own
`IDENTITY_CONTRACTS` list, which exposed `identity.organization.find`, `identity.organization.create`,
`identity.membership.find`, `identity.membership.create`, `identity.membership.delete`, and
`identity.role.find` with no `role`. Checked each one directly against the running server rather than
assuming from the list:

- `identity.organization.find` -- anonymous **read**: leaked (200, real rows).
- `identity.role.find` -- anonymous **read**: leaked (200, real rows).
- `identity.organization.create` -- anonymous **write**: reached input validation (400 for missing
  fields), meaning a well-formed anonymous request would have succeeded.
- `identity.membership.create` -- anonymous **write**: same -- reached validation, not blocked by auth.
- `identity.membership.find`/`.delete` -- correctly refused (401) by accident, not by design: both
  are `scopedBy: 'userId'`, and resolving that scope for a caller with no ticket throws before the
  gate would have mattered. `identity.organization`/`identity.role` have no `scopedBy` at all (an
  organization can't be scoped to itself; a role isn't tenant data), so nothing protected them.

This is exactly the gate mesh-operator's *own* `mesh.json` already documented, years before this
session touched any of it, as the correct one for `organization.find` and `membership.find`
specifically -- reasoning that was sitting right there and didn't make it into `composeConsole.ts`
when these got exposed.

Fixed live (patched the running server's `serve.expose` rows directly, verified anonymous access
now refuses with 401 on every one, then reverified the actual signed-in operator flow still works
end to end) and at the source (`composeConsole.ts`'s `IDENTITY_CONTRACTS` now carries `role:
'operator'` on all six, so a from-scratch redeploy doesn't reintroduce this).

Noted, not fixed: after signing in, a collection that failed its first (correctly-refused, pre-login)
fetch shows its stale "You need to sign in" state for roughly 1-3 real seconds before the
session-arrived retry (`mesh-web`'s own `query.ts`) completes and replaces it -- no distinct
"retrying" state exists in between. Cosmetic, self-corrects, not something this session's changes
caused (any collection whose first fetch predates its session would show this); it was just invisible
before because these particular collections had no gate to fail against.

---

## Done — `cdn.service.ts` was generating a page against a kernel API that no longer exists

Also found trying to stand up `console.localhost`, after the builder gap above was fixed: the page
built, downloaded every script, threw no console error, and rendered nothing. Two real bugs:

- [x] **`buildKernel`'s synthesized entry only exported `default`.** `import * as kernel from ...;
      export default kernel` compiles fine but gives every other part's `import { needs } from
      '@flybyme/mesh-web'` nothing to resolve against -- mesh-web has no default export, only named
      ones. Fixed: `export * from <mesh-web's entry>`, re-exporting the same named bindings.
- [x] **`cdn.service.ts` was built against an old kernel boot protocol.** It put `data-application`/
      `data-policy`/`data-open`/`data-api` on the kernel's own `<script>` tag and loaded every other
      part as its own flat `<script type="module">`. mesh-web's real entry point,
      `start(composition)` (`mesh-web/kernel/start.ts`), reads none of that -- it takes an explicit
      `{ application, api, policy, open, parts }` object and constructs+registers each part's default
      export itself. A part's module merely being *fetched* does nothing; nothing before this called
      `start()` at all. `cdn.service.ts` now generates a small boot module (`import { start } from
      '@flybyme/mesh-web'; import part_0 from '/assets/...'; ...; start({...})`), inlined as one
      CSP-hashed `<script type="module">`, in place of both the old kernel-script-with-data-attrs and
      the flat per-part script list. mesh-core's own docs (`auth/index.ts`'s comment on its default
      export) already named this exact module shape as `boot.js` -- nothing had ever generated it.
      Confirmed at the bundle level (kernel's export list contains `needs`/`element`/`provider`/etc.
      under their real names) before re-reporting this fixed, same as the import-map work above.

**Known gap, not fixed**: the old mechanism read a `mesh_ticket` cookie server-side
(`cdn.service.ts`'s `resolveTicket`/`parseCookies`, now deleted) so a returning signed-in visitor
skipped a login round-trip. `Composition` (`start()`'s input type) has no ticket field at all --
`AuthExtension` takes an optional `store: TicketStore` per-part instead, and nothing currently
constructs one from a server-resolved cookie and passes it as that part's `options`. A real feature,
just not wired past this session's actual blocker (a completely blank page).

## Done — four more bugs, found by actually loading the rendered page

`console.localhost` went from a blank page to fully working -- real windowed kernel chrome, the
identity app, live data -- across four more fixes, each found by reloading in a real browser
(`test/puppeteer/checkPage.ts`, see below) rather than by re-reading the code:

- [x] **CSP hash sources need their own quotes.** `script-src 'self' sha256-...` (no quotes around
      the hash itself) is silently dropped by the browser -- "contains an invalid source" in the
      console, not a header-rejected error, so it read as nothing being wrong until the inline boot
      script was blocked. Fixed: each hash gets wrapped (`'sha256-...'`) before joining.
- [x] **The kernel's own CSS was dropped.** mesh-web's entry does `import './kernel.css'`, so esbuild
      emits a real `entry.css` next to `entry.js` -- but `resolveWebRequest`'s `kind === 'kernel'`
      branch `continue`d before ever reaching the CSS-collection loop. The page rendered, unstyled,
      for every release, from the moment the boot-module fix landed. Fixed: the kernel branch now
      collects its own `.css` asset too.
- [x] **No public port for an unproxied api.** `serve.api.apiHost` has to stay a bare hostname
      (`resolveHostname` strips the port before matching, on purpose -- the same api answers whatever
      front door a request arrived through), so there was no way to say "the public origin needs
      `:17655`" for a local, unproxied dev setup. New `PUBLIC_API_PORT` env var, read only when
      building a *public-facing* origin (preconnect, CSP `connect-src`, the boot module's `api`
      field) -- never reused from `API_PORT` (the internal listen port), since those two are only the
      same number by coincidence of nothing sitting in between.
- [x] **No CORS handling anywhere in `api.service.ts`.** cdn and api are genuinely different origins
      (different host *and* port) the moment nothing proxies them onto one, and nothing had ever
      called this api from a real browser before now -- curl and the CLI don't enforce CORS, so nine
      months of `_describe`/CLI verification never would have caught it. `Access-Control-Allow-Origin:
      *` (safe here specifically because every call is bearer-token-authenticated, never
      cookie-credentialed -- the same reasoning `mesh-core/auth/extension.ts` already gives for
      staying bearer-only) plus real `OPTIONS` preflight handling, added at the top of the request
      handler.

**`test/puppeteer/checkPage.ts`** (new): loads a URL in the system's real Chrome via `puppeteer-core`
(no bundled Chromium download) and reports console messages, page errors, failed requests, and a
screenshot. Built because Claude-in-Chrome wasn't connected in the session that needed to verify all
four of these -- every one of them was invisible to `curl`/direct HTTP checks and only showed up once
something actually rendered the page.

---

## Done — chrome: a real entry point, a real sign-in, and the dispatcher gap that hid under both

`console.localhost` had windows but no shell around them (no chrome composed in at all), then a
shell with a sign-in button that silently did nothing, then a shell whose window host collapsed to
0 height. Three real bugs, spanning mesh-web, mesh-core, and mesh-serve's own git history reading,
not one — "make it right" meant tracing each to its actual root rather than patching the symptom:

- [x] **`chrome.ts` had no entry point.** Same gap `auth/index.ts` already had and was fixed for --
      `chrome/index.ts` now exists, default-exports `ConsoleChrome`, and `package.json` gained
      `"./chrome"`. Deleted `chrome/contract.ts` alongside it: confirmed via `git log` it was
      orphaned scaffolding from an unrelated generics-fix commit, never imported, redeclaring names
      `chrome.ts` already declared correctly.
- [x] **mesh-web's page-level dispatcher only ever resolved `{ kind: 'command' }`.** A window's own
      view gets a real per-instance handler table for free (`window/host.ts`'s `mountView`); chrome,
      rendered outside the window-host mechanism, had no equivalent -- every chrome written before
      this only used `command(...)`-bound intents, so the gap was invisible until `ui.SignIn`
      (real, complete, and previously wired into nothing) got embedded in chrome's banner for the
      first time. `PageChrome` gained an optional `handlers?: HandlerTable`; `start.ts`'s page
      dispatch now resolves `{ kind: 'handler' }` against it before falling through to the existing
      command path. 472 unit + 49 browser tests in mesh-web, all passing.
- [x] **chrome had no stylesheet at all.** `ui.css` is scoped to `src/ui`; nothing styled
      `.console`/`.console-banner`/etc., so `[data-mesh-window-host]` sat in a heightless flex column
      and every window rendered off-screen. New `chrome/chrome.css`, structural only, mirroring
      `kernel.css`'s own token fallbacks directly.

Verified with `test/puppeteer/signIn.ts` (new): fills the real form, submits it, confirms "Signed in
as operator." with zero console/page errors -- not a screenshot of a form that might work, an actual
completed sign-in against a live api.

**Not fixed, noted rather than silently designed:** `sidebar()` renders as a horizontal strip between
the tabs and the window host (it's a direct child of the same column flex, not a side rail) --
harmless today since nothing calls `ConsoleChromeApi.addNav` yet, so it's always empty, but a real
side-panel layout is undesigned work, not a bug to patch blind.

---

## Open — the builder never actually builds a real, multi-part site

Found trying to stand up `console.localhost` for real: `serve.repo` → `serve.part` →
`serve.artifact.requestBuild` → `serve.composition` → `serve.cdn.deploy` had never been exercised
end to end against a real kernel + extensions + application since this session's api/cdn/catalog
rework (the old `seed` command that used to drive this was deleted before this session even started
— see the "One SDK" section below). Two real bugs, one fixed:

- [x] **`buildKernel`'s synthesized entry assumed a default export.** `import kernel from
      <mesh-web's src/index.ts>` — but mesh-web's kernel entry is barrel re-exports only, no default,
      deliberately (its own header enforces the node/browser split, and every export in the file is
      named). Every kernel build failed outright. Fixed: `import * as kernel from ...`.
- [ ] **There is no external-import / import-map mechanism at all.** `runEsbuild` (`build.ts`) calls
      `esbuild.build({ bundle: true, ... })` with no `external` list, so building any mesh-core part
      (`ui`, `auth`, `identity`) fails immediately: `Could not resolve "@flybyme/mesh-web"` — the
      checked-out repo is a fresh `git clone` with no `node_modules`, and even if it had one, bundling
      the framework into every single part's artifact separately isn't what the rest of the system
      assumes happens. **mesh-core's own `mesh.json` already documents the intended behavior**,
      written before this gap was found: *"A part is bundled with one specifier external and
      everything else inlined from its own clone... The builder marks it external and the site's
      import map points it at this artifact, exactly as it has always done for `@flybyme/mesh-web`."*
      That mechanism does not exist. Two things are missing to build it: (1) `serve.part`'s schema has
      no field for "the specifier other parts import this one as" — only `key` (an internal
      identifier), not an `import` string like mesh.json's own per-part `"import":
      "@flybyme/mesh-core/ui"` field; (2) nothing generates an actual `<script type="importmap">` (or
      equivalent) in `cdn.service.ts`'s served HTML mapping those specifiers to the release's pinned
      artifact URLs, and nothing tells esbuild which specifiers to mark `external` per part. Real
      design work, not a quick fix — flagged rather than improvised.

---

## Done this session (continued — real integration test coverage)

- [x] **`test/bootstrap.integration.test.ts`.** Everything above was verified by hand, repeatedly, and
      none of it had automated coverage — the exact gap flagged earlier in this file. Boots a real
      `MeshApp` (all four services, real MongoDB, real HTTP) once per file and drives it with real
      `fetch()` calls, in order: Platform org + owner membership + owner role exist for real; a real
      `serve.api` row backs the bootstrap host (not a hostname special-cased in code); `/api/_describe`
      answers; a request missing the `/api` prefix 404s (the routing fix stays fixed); an
      operator-gated call refuses with no credential (401) and with a non-operator session (403); the
      real first-boot operator (password captured from the real boot-time log message, not a stand-in
      account) claims their provisional account and `whoami` reports real organization membership
      afterward; `serve.repo.create`/`serve.part.create`/`serve.composition.create`/`serve.expose.find`
      all expose and work (the visibility fix stays fixed); `serve.api.generateClient` renders a real
      self-contained zod file over real HTTP; a site created with a real `apiId` round-trips it (the
      `serve.cdn`↔`serve.api` link stays linked). 11 assertions, ~1.3s, fully idempotent (drops its own
      database in `afterAll`, confirmed by running it back to back).

---

## Done this session (continued — regenerating mesh-operator's real client)

- [x] **`generate` dropped local wants-narrowing entirely.** `--wants`/`--contracts` meant the right
      output depended on two things agreeing (the api's live exposure, and whether a local
      `mesh.wants.json` was still accurate) instead of one. Now `generate --api <id>` always renders
      the full current exposure — deterministic, nothing else feeding it, same file every re-run
      against an unchanged api. `serve.api.generateClient` itself keeps the optional `contracts`
      filter server-side, for a real different future caller (a cdn build narrowing to a site's
      `serve.want`) — just not this CLI any more.
- [x] **`serve.repo`/`serve.part`/`serve.composition` were completely unexposable.** Found
      regenerating `mesh-operator`'s client for real: all three had `visibility: {}` — nothing on any
      CRUD action whitelisted public, so `serve.expose.add` refused every one of them. Nothing could
      create a repo, a part, or a composition over HTTP, for any caller, ever — a bigger gap than "no
      single seed contract" (the individual primitives weren't reachable either). `serve.expose`
      itself had the same problem for reads. Fixed the same way `serve.cdn` already does it
      (find/findOne/get/count/create public, update/delete internal; `serve.expose` reads only —
      writes stay behind the validated `add`/`remove` tools). Verified live, gated at `role:
      'operator'`.
- [x] **`mesh-operator/src/console/generated/api.ts` regenerated for real**, against a real exposed
      `serve.api` (all 16 originally-wanted contracts, once the above was fixed). Real zod, real
      `@flybyme/mesh-web/net` import, typechecks completely clean in mesh-operator's own build — the
      only remaining typecheck errors are in `contract.ts`/`index.ts`, which still reference the old
      generator's type names (the console port itself, still not started). Also found and fixed:
      `mesh-operator/package.json` had `@flybyme/mesh-web` pinned to `v0.16.6` (before the `/net`
      export existed at all) and never listed `zod` as a dependency despite the generated file
      needing it directly — bumped to `v0.17.1`, added `zod`.

---

## Done this session

- [x] **`/api` routing mismatch.** The server matched contract routes (`findRoute` in
      `api.service.ts`) with no `/api` prefix, while `buildDescriptor` advertised `base: "/api"` and
      every generated client prepends it. Every real call except the hardcoded `/api/_describe`
      special case would 404. Fixed with a shared `API_BASE` constant (`methods/descriptor.ts`),
      stripped before route matching.
- [x] **mesh-serve's own CLI rebuilt on typed clients.** `login`/`logout`/`switch`/`refresh`/
      `generate`/`start`/`help`/`exit` are real `BaseCommand` classes calling through
      `@flybyme/mesh-web/net`'s `createClient`/`call`/`defineApi` — the same mechanism any other
      consumer uses. Deleted the old dynamic-`_describe`-fetching apparatus this replaced
      (`describe.ts`, `execute.ts`, `commandTree.ts`, `dispatchMeta.ts`, `ensureDescriptor.ts`,
      `metaCommand.ts`, `oneShot.ts`).
- [x] **`identity.user.setPassword` unreachable on a fresh install.** Not in
      `DEFAULT_EXPOSED_CONTRACTS`, and no way to add it (`serve.expose.add` requires a `siteId`, and
      a default-host row is exactly the row with none). A first-boot account could log in, call
      `whoami`, and nothing else — including the one call the boot message promises it can make.
      Added to the default-exposed list.
- [x] **Dynamic CLI dispatch restored.** The rebuild above dropped the ability to call whatever a
      host happens to expose (`mesh-serve identity whoami`), keeping only the fixed baseline. That
      was a real capability loss, not an intentional cut. Restored as a live `domain action` tree
      (`src/cli/dynamic.ts`), fetched fresh from `/api/_describe` every invocation rather than cached
      in the session file — nothing to go stale between a `switch`/`login` and the next command.
- [x] **REPL line-ordering race.** `rl.on('line', async ...)` doesn't wait for one handler before the
      next buffered line fires — three piped REPL lines ran concurrently and the third (`exit`) closed
      the interface before the first two printed anything. Switched to `for await (const line of rl)`.
- [x] **Piped-stdin `question()` race.** Same class of bug, `src/cli/prompt.ts`: two lines of piped
      input arrive in one chunk and both `'line'` events fire before the second `question()` call
      attaches its listener, so a scripted `login` died after the email prompt. Fixed with a shared
      async iterator per `readline.Interface` instead of one-shot listeners.
- [x] **`src/examples/whoami.ts`.** Proof the SDK (`@flybyme/mesh-web/net`'s `call`/`defineApi`/
      `createClient`) is standalone — no CLI, and, after a correction, no reach into mesh-serve's own
      `../identity/contracts/*.ts` either. A real external consumer never has that directory; a script
      that only works because it lives in the same repo as the server isn't actually standalone. Uses
      `z` from `@flybyme/mesh` (the same zod every contract here is written against) and its own
      hand-declared schemas, `.parse()`d for real on the way out and the way back — `call<>()`'s type
      parameters are compile-time only, `createClient` never runs a schema against the wire itself.
- [x] **The bootstrap gap, and the `api`/`cdn` split, both landed together.** First boot now creates
      a real "Platform" organization (`identity.service.ts`), the operator becomes its `owner`
      (a real org-scoped role — none existed before this, so *every* organization's memberships were
      silently granting nothing; `resolveEffectiveRoleKeys` drops a `roleKey` with no matching
      `identity.role` document), and a new first-class **`serve.api` collection** replaces the
      `DEFAULT_API_HOST`/`DEFAULT_EXPOSED_CONTRACTS`/`resolveDefaultExposeRows` special case entirely
      — `api.localhost` is now an ordinary `serve.api` row in that tenant, resolved the same way any
      other host is. `serve.expose` is rekeyed from `siteId` to `apiId`, referencing `serve.api`
      directly rather than a `serve.cdn` site — so an API-only presence needs no frontend hostname at
      all. `generate --site <id>` is now `generate --api <id>`, matching. Verified live on a fresh
      install: real `identity.organization`/`identity.membership`/`serve.api`/`serve.expose` rows,
      `whoami` reporting real org membership that didn't exist before this fix, `setPassword` and
      `generate` both working end to end against the bootstrap api, generated output typechecking
      clean. `serve.cdn` (the frontend/UI concept) is untouched — still bundles `host`+`mcpHost`+
      release/theme/policy on one row; it does not yet reference a `serve.api`, see below.

---

## Open — what's left of the `site` split

- [x] **`serve.cdn` now references `serve.api`.** `apiHost` is gone from `siteSchema`, replaced by an
      optional `apiId` (absent means a UI-only site that calls no exposed contracts of its own). The
      dead `serve.cdn.resolveApiHost` contract/tool/mount are deleted — nothing called it any more
      once `api.service.ts`'s routing moved to `serve.api.resolveByHost` in the previous change.
      `cdn.service.ts`'s HTML render and CSP header both resolve `site.apiId` → `serve.api.apiHost`
      once per request (`resolveApiHost`) and degrade cleanly (no preconnect link, no `data-api`
      attribute, no api entry in `connect-src`) when a site has none. Verified live: a real site
      created with a real `apiId` resolves it correctly before hitting the (expected, unrelated)
      "Site not deployed" check.
- **What would `generate --cdn <id>` actually produce?** Still unanswered. `generate --api <id>` is
  clear — the same real-zod `call`/`defineApi` shape as today. A CDN/UI-only site doesn't need a typed
  *client*, it needs its already-built JS bundles served, which `serve.artifact`/`serve.composition`/
  `serve.release` already do. Unclear whether `--cdn` means a local dev-preview config
  (`theme`/`policy`/`open` as a file), something else, or isn't a "generate a file" operation at all.

`--want <id>` was considered and set aside: "want" (a part's own declared calls, or `serve.want`'s
per-site materialized union of them) answers *how much of an exposure to include*, not *which
exposure to ask*. Those are two different axes — which `api` to generate **from**, and how to
**narrow** what comes back — and conflating them into one flag loses that distinction.

---

## Open — `defineCommand`/`defineView`, and a mesh-web-side generator

`mesh-operator/src/console/contract.ts` hand-writes `PUBLISHES.commands` as a plain array, then
separately indexes it by **position** into `DECLARED` (`PUBLISHES.commands[0]`, `[1]`, ...). This
already broke once, for real: adding `registerUser` shifted `signOut` from index 2 to 3, nothing
updated the reader, and the sign-out command shipped carrying the register command's action,
description and schemas — invisible to the compiler, because every entry has the same shape.

Same principle that makes `ctx.call` typed via `defineContract` + `mesh generate`: a hand-maintained
parallel structure drifts, a scanned declaration can't. Two separable pieces:

- [ ] **S — `defineCommand()` (and `defineView()`?) as named, referenceable values.** Kills the
      position-index bug immediately with no scanner involved: `DECLARED.signOut` becomes a direct
      reference to the same `defineCommand(...)` call `PUBLISHES.commands` includes, not an index into
      an array that can silently reshuffle.
- [ ] **L — a mesh-web-side scanner**, parallel to `mesh generate`'s contract scan, discovering
      `defineCommand`/`defineView` across a repo and emitting a global registry — mirroring
      `IServiceToolRegistry` for the RPC side. Payoff: one part could call another's published command
      by string id with full type inference, no import, the same way `ctx.call('domain.action', ...)`
      already works with no import today. Comparable in size to the existing generator; deserves its
      own design pass rather than being decided as a side effect of the console rewrite.

---

## The "One SDK" plan is fully complete

Checked directly against each repo's own git log, not assumed from memory — every part of it landed:

- **Part 1 (mesh-web, `cx.mesh.call` throws).** `0.17.0` — `coerceResult`/`isTypedResult` are gone
  from `src/`, `models.ts`/`query.ts`/`broker.ts` all use `MeshCallError` directly.
- **Part 2a (relocate mesh's CLI/scanner into mesh-serve).** `mesh/src/cli/` no longer exists at all;
  `mesh-serve/src/cli/core/` now holds `BaseCommand`/`CommandRegistry`/`ZodToCliMapper`. mesh's own
  `git status` is clean — the removal is committed, not a pending risk.
- **Part 2b (real zod-backed generator)** and **Part 2c (`@flybyme/mesh-web/net` subpath)** — both
  live; `0.17.1` published `/net` as its own export. This is what `generate --api <id>` and
  `src/examples/whoami.ts` both depend on, verified live and in `test/bootstrap.integration.test.ts`.
- **Part 3 (mesh-serve's own CLI rebuilt on it)** — done, see "Done this session" above.

Nothing from that plan is still open. `mesh-operator/src/console/generated/api.ts` is also already
regenerated for real (zod, `/net`, typechecks clean) — the line that used to be here saying otherwise
was stale, corrected 2026-09-15.

## No longer blocked, not yet done

- **The console port itself** (`contract.ts`, `index.ts`, `views/*.ts`) — the whole `seedSite` command
  is built around a `site.seed` contract that no longer exists — mesh-serve only has the separate
  primitives now (`serve.repo.create` → `serve.part.create` → `serve.artifact.requestBuild` →
  `serve.composition.create`/`.compose` → `serve.cdn.create` → `serve.cdn.deploy` → `serve.expose.add`).
  Fully unblocked (real generated client exists, `cx.mesh.call` already throws) but not started.
  Still an open question whether it waits on `defineCommand`/`defineView` or goes ahead without them.

## 2026-09-16 — porting flowboard onto this rebuild found two real gaps here, not there

**A flat `{ tenant_id }` meta override is silently defeated by the caller's own ambient meta.**
`ServiceBroker.internalCall` (mesh, frozen) builds a nested call's meta as
`{ ...activeCtx.meta, ...options.meta }` — a *shallow* merge — and `resolveCallerScope` checks
`meta.user` before a flat `meta.tenant_id`. So a tool that is itself reachable over HTTP for an
authenticated caller (its own `ctx.meta.user.tenant_id` already set to the caller's tenant) and that
tries to override the tenant for a *nested* call by passing a flat `{ tenant_id: X }` gets that
override silently ignored — the outer `user.tenant_id` object survives the merge untouched and wins.
Found in `serve.expose.add`/`.remove`: exposing a contract on another tenant's api, called by an
operator through their own api, landed the `serve.expose` row in the *caller's* tenant, not the
target api's — undetected until this session actually tried a genuine cross-tenant expose (every
existing test exposed contracts on the caller's own api). Fixed by nesting the override under `user`
(`{ user: { id: ctx.meta?.user?.id, tenant_id: X } }`) — replacing the whole key wins the shallow
merge outright. Regression test: `test/bootstrap.integration.test.ts`, "exposing a contract on
another tenant's api lands the expose row in that tenant, not the caller's" (fails without the fix,
confirmed by reverting it locally).

**Not yet fixed, same root cause, wider blast radius:** `serve.part.resolve`/`.find` (and by
extension `serve.artifact.requestBuild`, `serve.part.start`, `serve.part.stop`,
`serve.composition.compose`) call `ctx.call('serve.part.resolve', { id })` with *no* meta override at
all — they inherit whichever tenant the caller's own api put in their ambient meta. `resolve` is
scoped exactly like `get` (`DatabaseMiddleware`'s `case 'resolve'`), so resolving a part belonging to
tenant B while calling through tenant A's api returns nothing (never throws NotFound — it's a lookup
tool, not a CRUD read), and every one of those operations reports 404 as if the part didn't exist.
Worked around today by calling these through the *target tenant's own api* instead (once that api
exists and is itself correctly scoped) rather than through an operator's home api — genuinely fine
once a tenant has its own api, but real for the same first-resource bootstrap moment B3 in
flowboard's own roadmap is about, one layer up: an operator wanting to build/start/stop a service
for a brand-new tenant that has no api exposing these calls yet has no path in at all. Not fixed
here — needs a deliberate decision (an operator-aware unscoped resolve, matching
`serve.api.resolveById`'s own pattern, vs. requiring the target tenant's api to exist and be used
directly) rather than a quick patch.

**A gate-free (deliberately public) scoped collection 401'd for every anonymous caller, always.**
`ApiService.handleRequest` set `meta` to `undefined` outright whenever `resolveCaller` found no
bearer token, on the reasoning that "no caller" and "no meta" were the same fact. They are not:
`target.tenantId` (the api's own owning tenant) is known regardless of who's asking, and
`DatabaseMiddleware` hard-refuses to run *any* action on a scoped collection — including a `find`
the site marked public with no role/permission — without a resolved scope in `ctx.meta`. So `serve.
repo.find` exposed with no gate, or flowboard's `project.find`/`card.find`/`sprint.find` (same
pattern), 401'd for a signed-out visitor even though nothing about the exposure said it should.
Found live: flow.localhost's board loaded but every collection read failed for a not-yet-signed-in
visitor.

Fixed by always building `meta.user` with a resolved `tenant_id`, using `id: ''` in place of a real
caller — `resolveCallerScope`'s own `.length > 0` check already treats an empty string as
unresolved, so a *userId*-scoped collection (`identity.membership`) still correctly refuses
anonymous access; only tenant-scoped, gate-free reads are unblocked. Two tools that used to check
`ctx.meta?.user?.id === undefined` to detect "no caller" (`identity.whoami`, `identity.user.
setPassword`) needed the same `=== ''` addition, since `meta.user` is no longer absent, just empty.
Regression test in `test/bootstrap.integration.test.ts` (fails without the fix, confirmed by revert).

**`ensureNpmInstall` needed `--omit=dev`.** A repo's own dev tooling can carry a `file:../sibling`
devDependency that only resolves in a normal working-directory checkout — the catalog builder's
isolated per-repo workdir (`~/.mesh/repos/<repoId>`) has no such sibling, and `npm ci` refuses the
whole install over one unresolvable *dev* dependency for a package the build was never going to
import. `--omit=dev` is correct in general, not just for this case: esbuild only ever resolves what
the entry point actually imports, so a repo's own test/CLI tooling should never be able to block a
production bundle from building at all. Found building mesh-core's `ui`/`auth` extensions
(`@flybyme/mesh-serve: file:../mesh-serve` in `devDependencies`).

**No real-time `/api/events` endpoint exists.** flowboard's generated client (and console's own,
by the same convention) declares a live-update `events` list and mesh-web's `net/eventsource.ts`
expects to open one — `ApiService` has never implemented an SSE (or any) `/api/events` route at
all. Every collection read still works as a one-shot `find`; nothing crashes, a board just never
updates itself when another tab or agent writes to it without a manual reload. Not attempted here —
a real streaming endpoint is its own piece of work (source: which of a site's *scoped* collections'
`created`/`updated` events a specific connected, authenticated caller may actually receive, matching
`checkGate`'s own role/permission logic per event rather than per call).

**Added `mesh-serve init`/`publish`, and found three more real bugs building them.** The One SDK
plan's Part 5 (resume the console port) turned out to already be waiting on this: mesh-operator's
own `composeConsole.ts` names it directly — `site.seed`'s single-call convenience was deleted before
this session's rebuild because stacking repo/part/build/compose/deploy behind one server-side
contract made the steps unobservable and hard to retry from the middle. `init` (a wizard) and
`publish` (rebuild+recompose+redeploy an existing site) rebuild that convenience client-side, over
the real primitives, using the same generated-style typed client (`src/cli/api.ts`, extended) every
other CLI command already uses. Driving them against a real, freshly-bootstrapped node surfaced:

- **Piped, non-interactive stdin silently hangs if any `await` runs before the first `question()`.**
  `prompt.ts`'s shared async iterator was created lazily, on first use — fine when nothing happens
  first (`login`'s two questions are back to back), but `init`'s self-heal `expose.add` loop runs
  several awaited HTTP calls *before* its first prompt, and on piped input the readline stream can
  reach EOF and close before anything ever asks for the iterator; requesting it afterward resolves
  every future `.next()` against a dead source with no error. Reproduced directly (delay before vs.
  after the first `question()`) before fixing. Fixed with a new `warm(rl)`, called immediately after
  `readline.createInterface(...)` in any command whose first prompt isn't also its first line.
- **A GET `find`/`find_one` call with an object `query` filter never worked over real HTTP, for
  anyone, ever.** `mesh-web/net`'s client-side `toRequest` JSON-stringifies an object/array input
  value into the query string (`query: { partId }` → `?query=%7B...%7D`) — correct encoding, but
  `ApiService.parseInput`'s GET branch took every query-string value as a literal string with no
  decode step, so the schema saw `"query": "{\"partId\":...}"` and rejected it ("Expected object,
  received string"). Never caught before because every find call anywhere in this codebase either
  passed no filter (relying on defaults) or ran through an in-process `ctx.call`, which is a real JS
  object end to end and never touches a query string. Fixed with a symmetric decode (`decodeQueryValue`):
  a query-string value is JSON-parsed and used only if the result is actually an object or array,
  so an ordinary scalar filter is never misinterpreted.
- **`--omit=dev` (this file, one entry up) broke the very first repo it was tried against for real.**
  mesh-web's `package.json` has `"prepare": "npm run build"` (its own `tsc`), which `npm ci` runs
  automatically — and fails outright once `--omit=dev` removes `typescript`. esbuild bundles straight
  from a part's `.ts` source and was never going to read that lifecycle script's output anyway.
  Fixed by adding `--ignore-scripts` alongside `--omit=dev`, which was always the correct pairing:
  skip a checkout's own build tooling entirely rather than merely its resolution.

Verified live end to end, not just typechecked: a fresh node, first-boot bootstrap, `init` building
a real kernel part from `mesh-web`'s `console-demo` ref and deploying it as a reachable site (`curl`
200, correct asset hash), then `publish` rebuilding and redeploying that same site to a new artifact
hash, confirmed by the served HTML changing to point at it.

**Two more real gaps, found walking a fresh install through the CLI alone (no curl, no Mongo).**
After a first-boot account is created it's `provisional` and can, per identity.service.ts's own
printed message, "do nothing except set its own password" -- but `identity.user.setPassword` is
bootstrap-exposed and nothing in the CLI ever called it, so the only way to claim the account was a
hand-built curl. Added `mesh-serve claim [password]` (prompts with confirmation if omitted). Separately,
`init`/`publish`/`generate` all required `--api <id>` (and `init` also `--tenant <id>`), and the only
way to learn either was a raw Mongo query against `serve.api` for the api you were already logged
into -- `serve.api.resolveByHost` exists and is `visibility: 'public'` but was never bootstrap-exposed.
Added it to `BOOTSTRAP_EXPOSED_CONTRACTS` (public, matching `serve.cdn.resolveHost`'s own "for a
caller who has nothing else yet" gate) and a shared `resolveApi()` helper so `--api`/`--tenant` are now
optional overrides, defaulting to whatever api/tenant the CLI is currently logged into. Re-verified the
whole bootstrap-to-deployed-site walkthrough end to end using only `mesh-serve` commands: `start` →
`login` → `claim` → `init --org-slug <slug>` → `publish --host <host> --ref <ref>` -- no curl, no Mongo.

**Closed the last real gap: `--org-slug` too, and `init -c <config.json>`.** `identity.organization.get`
is `visibility: 'public'` but wasn't bootstrap-exposed either; added it (public, same reasoning as
`resolveByHost`) so `init` looks up an organization's slug from `--tenant` when `--org-slug` is
omitted. Separately, a real interactive run hit a genuine, unrelated failure four prompts deep (a
`ref` that didn't exist on the repo actually named) and there was no way to fix one answer and
continue -- only start the whole wizard over. `init` now takes `-c/--config <file>`, a JSON manifest
(`{ host, compositionKey?, title?, repos: [{ url, ref, parts: [{ name, kind?, path?, entryPoint,
imports? }] }] }`) validated with zod, run non-interactively through the exact same pipeline the
interactive path uses (`collectInteractively`/`loadConfig` both just produce a `WizardInput`) -- so a
real deployment becomes a file worth checking in and re-running, not a transcript to retype.

**Added `org-create`/`api-create`, found needing a second tenant.** `init --tenant <id>` can create
inside any organization (`resolveEffectiveTenantId`'s operator override), but there was no way to
*make* a second one -- `identity.organization.create` and `serve.api.create` are both `visibility:
'public'` and neither was bootstrap-exposed, and nothing in the CLI called either. Found standing up
flowboard's app for real: it was deployed under the `platform` tenant/api by default, which is wrong
-- an app's own data (and its backend's own exposed contracts) belong to its own organization and its
own api host, not the platform's operator-only control plane. Added both commands, self-exposing their
one contract the same way `init`/`publish` do. A fresh api still starts with nothing exposed on it
(unlike the bootstrap api) -- that's `init`'s own self-heal, or a direct `serve.expose.add`, from there.

**A real, previously-unhit bug: self-heal exposed contracts on the *target* api, but every operational
call still went to the *login* host.** Every earlier test happened to target the same api the CLI was
logged into, so `serve.expose.add({apiId: flow-api-id, ...})` and the very next `serve.repo.create`
both landing on `session.apiHost` (api.localhost) never disagreed. The moment they differ -- an
operator building on a second tenant's own api for the first time -- every operational call 404'd
("That does not exist.") against a host that had never been exposed anything, while the *target* api
sat there correctly configured and unreachable. `serve.api.resolveById` is now bootstrap-exposed
alongside `resolveByHost`, and `resolveApi()` returns the target's real hostname (port-preserved from
the session's own, since this node serves every api on one port with no reverse proxy); `init`/
`publish`/`generate` now build a second client pointed at it for everything after the one
`serve.expose.add` step, which is the only call that has to go through the login host.

**`init -c` now describes a whole app, not just its browser-side parts.** Extended the config schema:
`org` (must already exist -- init throws rather than silently creating one on a typo; membership is
checked too, past whatever `identity.hasRole`'s operator bypass would otherwise allow silently),
`api` (created automatically if that hostname doesn't exist -- no ownership question once its
organization is already verified), `contracts` (an app's own backend domain contracts, e.g.
`project.find`, exposed alongside the fixed set `init` always needs), and `service` (the app's
backend: built and started the same way any `kind: 'service'` part would be, kept separate because it
isn't composed into the site). One real ordering bug found building this: a contract has to be
registered in the node's broker -- which only happens once the `ServiceModule` that mounts it is
actually running -- before `serve.expose.add`'s own `isPublicContract` check can see it; exposing an
app's contracts before its service starts fails "is not a public contract", indistinguishable from a
genuinely-internal one. Fixed by exposing `config.contracts` after the service starts, not before.
`identity.organization.find_one` bootstrap-exposed for the same "look an org up with nothing else yet"
reason as the two `resolveApi` calls above it.

Verified live end to end against a real two-tenant cluster: `Flow` organization, `flow-api.localhost`
(separate from the platform's own `api.localhost`), a real kernel+ui+auth+app frontend at
`flow.localhost` correctly pointed at `flow-api.localhost` in its own boot config, and flowboard's
real backend service built, started, and answering `GET /api/projects` with `200 []` rather than
404/connection-refused.
