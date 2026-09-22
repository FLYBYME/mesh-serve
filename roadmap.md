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

**Made `init` idempotent, found rerunning it against real state.** `serve.repo.create`, `serve.part.
create`, `serve.composition.create`, and `serve.cdn.create` all CONFLICT outright on a rerun of the
same config -- none of them were find-or-create. Found live: the first sign-in attempt through
`flow.localhost` 404'd (nothing exposes `identity.ticket.issue` on a non-bootstrap api, same class of
gap as `organization.find_one` and `resolveById` before it -- fixed by hand for now, `contracts` is
where it belongs going forward), and simply rerunning `init -c` to fix it failed outright on the
already-existing `mesh-web` repo. Added a small `findOrCreate` (create; on `CONFLICT`, re-find the
existing row instead of failing) used for all four creates in `buildSite` and the service's own repo/
part. A build failure from a transient DNS hiccup (`Could not resolve host: github.com`, nothing to do
with this code) confirmed the property directly: rerunning `init -c` a second time reused every
already-created id untouched, rebuilt cleanly, and redeployed -- config-driven `init` is now safe to
run again any time, the same way `publish` already was.

One idempotency gap remained, found by the person actually running it a second time within the same
node's lifetime: `serve.part.start` throws ("already running on this node") rather than being a
no-op, since a service's running state is only ever in-memory (`services.ts`), never persisted --
`startService.ts` has no dedicated error kind for it, just a 400 with that exact wording, matched and
swallowed the same way. Verified live, twice in a row against the same running node: a fresh start
succeeds normally, and an immediate rerun logs `"flow/server" is already running.` instead of failing.

**`findOrCreate` alone was still wrong: it never reconciled drift.** Found by the person actually
editing `flow.init.json` (switching `flowboard`'s repo url and two refs) and rerunning it: the refs
applied (real, differently-hashed rebuilds), but the repo url change silently didn't -- a new, unused
`serve.repo` row got created for the new url, while `flow/app`/`flow/server` kept pointing at the old
one, because `create` never runs again once a part's *key* already exists, and nothing ever told the
existing row its `repoId` was now stale. `update` was `internal`-only on `serve.repo`/`serve.part` (no
tool wrapper the way `expose.add`/`artifact.requestBuild` have one) -- exposed both as `public`,
catalog.service.ts's own `validatePartKey` hook already covers `update` the same as `create`. `init`'s
`findOrCreate` gained an optional `reconcile(existing)` step, used for repo (`defaultBranch`) and part
(`repoId`/`kind`/`path`/`entryPoint`/`imports`): a real field mismatch now issues an update instead of
being silently kept. Verified live end to end: changed `flowboard`'s repo url and two refs, reran
`init -c`, and confirmed directly against Mongo that `flow/app`/`flow/server`'s `repoId` now points at
the new repo -- the rebuilt artifact hash differing from every earlier run confirmed it built from the
new source, not the old one it would have silently kept.

**A real catalog builder bug, previously invisible: rebuilding a repo a second time never actually
picked up new commits on a branch.** `ensureRepoCheckout`'s `git fetch --all --tags` correctly moves
`origin/<ref>`, but the following `git checkout ref` + `git reset --hard ref` operate on the *local*
branch of the same name -- which `fetch` never touches. A workdir's first build (a fresh `git clone`)
had a local branch that already matched origin, so this was invisible every single time this session
built anything, until a *second* build of the same already-cloned repo, at a ref with genuinely new
commits on it, which idempotent `init` reruns now do routinely. Found live: `mesh-core`'s `rebuild`
branch had gained a `Studio` module locally that was never pushed to the local bare mirror used for
builds; after pushing it, the *build* still reported "Entry point not found" -- the isolated clone's
local `rebuild` was still 47 commits behind `origin/rebuild` from an earlier build, and re-fetching
never moved it. Fixed: when `origin/<ref>` exists, force the local branch to match it
(`checkout -B ref origin/ref`) rather than trusting whatever the local branch already was; a tag or a
raw commit sha (no moving `origin/<ref>` to reconcile against) keeps the original plain `checkout`/
`reset --hard` behavior, since forcing those into a same-named local branch would wrongly replace a
tag's detached-HEAD checkout with an attached one.

**`sync.ts`'s CLI silently overwrites the wrong site's generated client if you run it directly against
anything but console.localhost.** `parseArgs`'s `outPath` defaults to `DEFAULT_OUT_PATH` --
`mesh-operator/src/console/generated/api.ts`, hardcoded -- and `main()` always passes that concrete
value to `syncSpec`, never `undefined`. So `effectiveOut = outPath ?? site.generatedClientOut` never
falls through to the site's own declared path when invoked from the CLI: every `--site` argument
still writes to mesh-operator's console client unless `--out` is given explicitly. `sync-all.ts`
avoids this correctly (it calls `syncSpec(file, undefined, force)`, letting each site's own
`generatedClientOut` govern), which is exactly why it went unnoticed until `sync.ts` was run by hand
against a non-console site. Found live: `npx tsx src/sync.ts --site
/home/ubuntu/code/company/sites/company.site.json --force` overwrote mesh-operator's real console
client with one generated from company.site.json's much larger `exposed` list -- caught immediately
only because console.localhost was checked right after, and fixed by re-running `sync.ts --site
src/console.site.json` to restore it. `DEFAULT_OUT_PATH` should fall back to the site spec's own
`generatedClientOut` the same way `syncSpec`'s own default parameter already does, rather than a
second, contradicting default living in `parseArgs`.

**Every `kind: 'service'` part failed to start, the first time anything actually exercised that path
for real.** `sync.ts`'s `syncServices` calls `serve.part.start` for each service part so its
contracts are registered before `syncExposed` tries to publish them -- previously untested end to
end, since composing/deploying browser-facing parts never touched this. `startService.ts` dynamically
`import()`s the built artifact, which does a bare `import '@flybyme/mesh'`; that consistently threw
`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in .../node_modules/@flybyme/mesh/package.json`
under `npx tsx src/cli/index.ts start` (mesh-serve's own dev `start` command), even though the exact
same `import()` of the exact same file succeeds under plain `node`. Root cause: `tsx`'s own
path-resolution hook probes every bare specifier through Node's CJS-flavored `packageExportsResolve`
before falling back to the real ESM loader; `@flybyme/mesh`'s `exports` map declared only an
`"import"` condition, so that probe hard-failed instead of falling through to the working path.
Fixed in `mesh` (not mesh-serve) v3.1.5 by adding a `"default"` condition -- the exports spec's
condition-agnostic fallback -- alongside `"import"` on every export entry, pointing at the same file.
Reproduced directly with `npx tsx --input-type=module -e "import('file://.../index.js')"` against a
real built service artifact before and after the fix to confirm root cause, not just symptom.
Verified live: restarted a real node on v3.1.5, reran `sync-all.ts`, all 5 sites (`console`,
`company`, `dns`, `git`, `mail`.localhost) synced clean and served real `200`s. Anything that starts
a `kind: 'service'` part under `tsx` again should not hit this -- but a compiled/production `node
dist/...` start path was never actually broken by this in the first place, only `tsx`-hosted dev runs
were.

---

## Done — a `register()`-shaped `kind: 'service'` part cannot be cleanly restarted

Found live, composing `dns.site.yaml` end to end for the first time against real third-party repos
(`surfdns-registry`, `surfdns-domains`, `surfdns-nameserver`) rather than mesh-serve's own six core
parts. Every one of those repos' `kind: 'service'` parts uses `register(broker)` -- the shape
`loadModule.ts` already documents as the one that "mounts whatever it likes without telling anyone",
so unloading one "can run its `stop` and evict its module but cannot unmount its contracts". That
sentence was written correctly and abstractly; this is the first time anything actually hit the
concrete consequence.

Sequence: `serve.part.start` mounts `domain.create` etc and marks the part running. `desired`
defaults `'stopped'` on every `serve.part` row (correctly, per its own schema doc -- nothing should
run unless declared to), and `dns.site.yaml` did not set `desired: running` on either service part
(a straightforward authoring mistake, now fixed in that file). `serve.part.reconcile`'s next 30s
tick therefore calls `serve.part.stop`, which -- because `register()` recorded no contract list --
evicts the `require.cache` entry (so a fresh `require()` would load new code) but leaves
`domain.create` and every other contract the module registered still live on the broker, and clears
the in-memory "is this running" tracking regardless. The next `serve.part.start` (the very next
`sync` rerun) sees "not running", proceeds to `loadAndRegisterModule` a fresh copy, and
`registerContract`'s own duplicate-key guard throws `"domain.create" is already mounted on this
node` -- a 500, not the clean 400 "already running" a stale-tracking case would produce.

**Immediate, sufficient fix for now**: declare `desired: running` on every `kind: 'service'` part
meant to stay up, so the reconciler never calls `stop` on it at all. Done for `dns.site.yaml`.

**Fixed**, the same day, on a simpler mechanism than either direction above considered: no wrapping,
no refusal. `loadAndRegisterModule`'s `register` branch now snapshots `broker.listContracts()`
immediately before calling `register(broker)` and again immediately after, and records whatever tool
keys are new as the contract list `unloadAndEvictModule` unregisters. Every contract a `register()`
call mounts is already sitting in that list the instant `registerContract`/`registerCrud` runs --
that is the whole reason the list exists -- so this needed no cooperation from any `register.ts` at
all, past or future. `loadDomain` gets its own clean unmount by filtering the *same* information
down to one domain before mounting anything; this is the identical filter run after the fact instead
of before, because `register()` mounts first and names no domain up front.

Both wrong turns worth naming, since they were the first two things this looked like: wrapping the
broker handed to `register()` would have worked but is strictly more machinery for the same answer,
and refusing to stop a `register()`-shaped part at all would have papered over a bug that had an
actual fix instead of designing around it.

Verified with a new, real fixture (`test/fixtures/register-shape/widget.ts`, a genuine
`register(broker)` export -- not a mock) and a new integration test
(`test/registerShapeRestart.integration.test.ts`) that starts it, confirms its contract is live and
callable, stops it, confirms the contract is genuinely gone (a 404, not just a claim), and starts it
again -- the exact sequence that used to throw `"domain.create" is already mounted on this node`.
Confirmed the test is load-bearing, not incidentally green: reverted just the `loadModule.ts` change
and reran it alone, which failed at the exact assertion (`unloaded.contracts` was `0`) the fix makes
true. 234/234 on the full suite with the fix in.

---

## Done — real multi-node deployment has no node-targeting over the api, and artifacts don't travel

Found reasoning through "how do I run surfdns code across 6 real VPS" rather than one localhost demo
process. Two separate, confirmed gaps, both load-bearing for that goal and neither exercised by any
test so far (everything tested this far has been one node):

**1. `serve.part.start` cannot be aimed at a specific node through the api.** `ServiceBroker.call`
(`mesh/src/core/ServiceBroker.ts:1063`) dispatches locally whenever the calling node already has the
tool mounted (`!targetNodeID && !this.localTools.has(toolName)` -- local wins, no registry lookup,
no placement). `serve.part` is one of `CATALOG_DOMAINS`, loaded on every node by `start.ts`, so
`serve.part.start` is always local on whichever node's `ApiService` actually receives the HTTP
request. `partStartContract`'s own doc comment (`part.contract.ts`) says targeting is "`ctx.call`'s
own job, the `nodeID` call option" -- true internally, but `gateway.ts`'s `handleRequest` never
passes `nodeID` through from an incoming request, and there is no `nodeID`-shaped input field on the
contract either (deliberately, per that same comment, to avoid two ways to say the same thing). Net
effect: **through the api -- the only sanctioned path, since mesh-serve's own CLI must not touch the
mesh network directly -- every `serve.part.start` call lands on whichever single node is running the
`api` core part, with no way to choose otherwise.** `createCorePartPlacement`'s own comment confirms
this is known and scoped out on purpose for third-party parts: "a third party's own service lives in
the artifact store behind `serve.part.start` and needs a `serve.part` row to find it; that is a
separate provider and is not built yet."

**2. Artifacts are node-local filesystem state, never replicated.** `artifactDir` (`catalog/methods/
artifacts.ts`) is `~/.mesh/artifacts/<hash>/` on whatever machine ran the build. `startService.ts`
resolves `artifactAssetPath(artifact.hash, jsAsset.url)` and loads it straight off that node's own
disk -- no fetch-if-missing, even though `serve.artifact.getAsset`/`getArtifact` already exist and
could serve the bytes from whichever node built it. Builds run wherever the `serve.queue` leader
currently is (`buildArtifact.ts`, dispatched off a `leaderScoped` interval) -- a single node, not
necessarily the one an operator later asks to start the part. A part built on node A and started via
node B's api will resolve a hash that never landed on B's disk and fail to load.

**Practical workaround with zero new code**, since each api instance dispatches locally: run a
`mesh-serve start --parts api,cdn` (or whichever core parts a box needs) on every VPS that should
host workloads, all joined into one mesh (`--host`, `--sharedKey`, `--bootstrapNode`, one shared
`MONGODB_URI` reachable from all boxes so `serve.part`/`serve.repo`/`serve.artifact` rows are the
same catalog everywhere) -- then use the CLI's `switch`/`login` to address a specific VPS's own api
directly when placing a part there. Because local-dispatch always wins, this is currently the *only*
way to choose the node. The artifact problem still has to be handled by hand in this workaround: a
part must be built and started against the same node's api (so the build and the local disk agree),
or the built `~/.mesh/artifacts/<hash>/` directory has to be copied to the target box out of band
before `serve.part.start` there.

**Fixed**, on a different shape than either draft above once `serve.part.reconcile` (`tools/
reconcile.ts`, added the same week this file's supervisor section was written) turned out to already
place every `desired: running` service cluster-wide via `registry.placementFor(part.key)` -- the real
gap was never "no placement at all," it was "no way to *pin*" a hash-based automatic pick can't
respect physical constraints like `paas/SERVERS.md`'s (DNS on `ns1`/`ns2`, mail on `surf`'s one
established sending IP). So the fix landed as two additive pieces instead of a `serve.part.start`
wrapper:

1. **Labels.** `NodeInfo.metadata` (`mesh`) already propagates to every peer for free -- `broadcast
   Presence` sends the whole local node record, and `registerNode` stores `metadata` as given -- but
   every constructor hardcoded `metadata: {}`. `Registry`/`PlacementRegistry`/`RegistryModule` (mesh
   v4.1.0) now accept a `metadata` option; `mesh-serve start --labels role=dns region=bhs` sets it.
   `serve.node.find` (new, `catalog/contracts/node.contract.ts`) lists what's online and its labels,
   optionally filtered by one. `resolveNode.ts`'s `resolveNodeSelector`/`nodesForLabel` resolve a
   `"key=value"` selector or an exact nodeID against `getAvailableNodes()`.
2. **Pinning.** `serve.part` gained `nodeSelector` (`catalog/schema/part.ts`), a sibling of `desired`
   rather than a parameter on the imperative `serve.part.start` (whose own "no `nodeID` field" doc
   comment stays correct and untouched -- pinning is declarative, not a one-off flag).
   `reconcile.ts` resolves it via `resolveNodeSelector` when set, `placementFor(part.key)` when not,
   and fails a pin that matches nothing online into `failed[]` with a clear message rather than
   silently falling back to automatic placement.
3. **Artifacts.** `serve.artifact` gained `builtOn` (set to `broker.nodeID` in `buildArtifact.ts` on
   every success). New internal contract `serve.artifact.fetchAssetBytes` (no `visibility`, same
   pattern as `serve.corePart.load`) reads one asset's real bytes off whichever node has them.
   `startService.ts`'s new `ensureArtifactPresent` checks the js asset locally first; if missing and
   `builtOn` names a different node, it fetches every asset in `artifact.assets` from that node
   (`{ nodeID: artifact.builtOn }`, the same internal targeting `reconcile.ts` already uses for
   `runningHere`/`start`/`stop`) and writes them into the local `~/.mesh/artifacts/<hash>/` before
   falling through to the existing `ensureArtifactNodeModules`/`loadAndRegisterModule` path unchanged.

**Verified**, not just typechecked: `mesh` 556/556 (two new specs assert a constructed registry's own
`getNode(id).metadata` reflects a passed `metadata` option and survives a later `registerContract`,
which is the whole mechanism labels depend on). `mesh-serve` 243/243, including two new integration
files exercising real two-`MeshApp` clusters (not mocks):

- `test/nodeLabels.integration.test.ts` -- `serve.node.find` reflects real labels and narrows by one;
  `serve.part.reconcile` resolves a label selector, an exact-nodeID selector, and reports (rather than
  silently swallowing) an unmatched one, distinguished from an ordinary unbuilt-part failure by the
  error text each produces.
- `test/artifactPortability.integration.test.ts` -- proves the fetch is real, not routing-only: two
  nodes are given genuinely separate artifact directories (`setTestArtifactDir`, a nodeID-keyed test
  seam in `artifacts.ts` that is always empty and a no-op in production -- one real node has exactly
  one real `~/.mesh/artifacts`), a build's bytes are written to only one of them, and after
  `serve.part.start` targets the other, its disk is asserted to now genuinely contain the identical
  fetched file. A second case confirms an artifact with no recorded `builtOn` (predates this field, or
  a genuinely unknown builder) fails cleanly rather than attempting a pointless self-fetch.

**Also found, not fixed (out of scope here):** no test before this one ever drove a real
`serve.part.start` handler far enough under `vitest run` to reach `ensureArtifactNodeModules`
(`build.ts`), which resolves `@flybyme/mesh` via `import.meta.resolve` -- Vitest's SSR module
transform doesn't implement that (`__vite_ssr_import_meta__.resolve is not a function`).
`registerShapeRestart.integration.test.ts` avoids it by calling `loadAndRegisterModule` directly for
unrelated reasons, and that happened to hide this too. `artifactPortability.integration.test.ts`
works around it (asserts the fetch's filesystem effect directly rather than requiring the call to
fully succeed) rather than fixing Vitest's SSR transform, which is unrelated to artifact portability.
Worth a real fix if anything else ever needs `serve.part.start` to succeed end-to-end under this test
runner.

---

## Done — a `long-running` contract in a `register()`-shaped part is never started by anything

Found live, putting `surfdns-proxy` on the real genesis node. `serve.part.reconcile` starts a
`desired: running` service with `serve.part.start`, which mounts a `register()` part's contracts and
stops there -- a `concurrency: 'long-running'` contract (`proxy.listen`, `dns.listen`) is never
called, so the part is "running" and binds nothing. Someone has to call `listen` by hand, and that
call does not survive a node restart: the reconciler brings the part back, the ports stay dark.

Two related findings from the same session, both fixed at the source rather than here:

- `proxy.listen` and `dns.listen` declared no `visibility`, which defaults to internal, and
  `serve.expose.add` refuses anything non-public ("is not a public contract") -- so neither could be
  called through the api at all. `surfdns-proxy` fixed (b088683); `surfdns-nameserver` still has it.
- `serve.part.start` does not touch `desired`, so a hand-started service is stopped by the very next
  30s reconcile tick (`desired` defaults `stopped`). Documented on the field, but easy to walk into:
  it looked like "running" for about half a minute.

**Fixed** (mesh-serve v0.7.0) with a new `serve.part` field, `onStart`: a list of `{ contract, params }`
the part declares, e.g. `[{ "contract": "dns.listen", "params": { "port": 53, "host": "<public ip>" } }]`.
The answer to "where do a listener's parameters come from" was neither of the two candidates above
(not the contract's defaults, and not `options`, which is documented as a mesh-web constructor
argument): its own field, so what a service *starts* is stated on the part like `desired` and
`nodeSelector` are.

Where it runs matters more than what it is. It runs inside `serve.part.start`, on the node that just
mounted the part -- not from `reconcile`, and not from outside. From outside it cannot work: an api
call lands on whichever node the balancer picks, so two nameservers sharing `dns.listen` cannot each
be told to listen. From `reconcile` it would run once per start but a failure would go unseen, since
the part is already "running" and the supervisor never looks again. Inside the start, it is local by
construction and survives every restart. **All or nothing:** an entry that throws unloads the part
again (unregistering a `long-running` contract aborts its `ctx.signal`, which closes any listener an
earlier entry opened) and rethrows, so the part is not-running and the next 30s tick retries from the
top -- a service that mounted but failed to listen is never left looking healthy.

Verified with `test/onStart.integration.test.ts` (real broker, real `register()`-shaped fixture with
a `long-running` contract): an entry gets its declared params; a failing second entry leaves nothing
listening and the part unloaded; a part with no `onStart` is untouched. Driven through `runOnStart`
rather than `serve.part.start` for the same `import.meta.resolve`-under-vitest reason as artifact
portability above.

---

## Done — a real multi-machine cluster: peers dropped as "ghosts of self", and a silent presence storm

Found the first time three real machines (edge1, ns1, ns2 -- every node `--host 0.0.0.0` on the same
port 6005) were joined into one cluster. Every earlier multi-node test ran on one machine, where each
node has its own port. Two bugs, one symptom-free-looking and one very loud:

**1. Peers were connected but never registered.** A node's identity in the registry is its address,
and `registerNode` discards any peer whose address overlaps the local node's ("ghost of self", a
debug-level log). A node advertised `ws://${bindHost}:${port}` -- `ws://0.0.0.0:6005` on a wildcard
bind -- plus whatever `TransportManager.getAddresses` enumerated, which was only loopback: its
`eval('require')('os')` throws inside an ES module and the surrounding `catch` swallows it. So every
node advertised the same addresses, every peer looked like the local node, and the transport joined
happily ("Peer connected", "Connected to MongoDB", `Node "ns1" up`) while `serve.node.find` listed
one node. Nothing in any log said why.

**2. It became a busy loop.** `handlePresence` decides a peer `isNew` *before* `registerNode` runs,
and replies to a new peer immediately so it learns about us. A refused peer is new on every packet, so
every packet drew a reply -- and the peer, refusing us the same way, did the same. Presence packets
ping-ponged at wire speed with no timer and nothing logged: all three nodes pinned one core at
100% within a minute of joining, and a `serve.node.find` that takes 1.8s took 13.4s. Any refusal path
(address conflict, not just this one) would have looped the same way.

**Fixed** in `mesh` v4.2.0: `handlePresence` returns without replying when the registry did not accept
the peer (regression test drives five packets from a refused peer and asserts zero replies -- it failed
with five before the change); and `advertiseHost` on `NetworkModule`/`MeshNetwork` -- the address a
node tells peers to dial, separate from the interface it binds, and the *only* address advertised when
set. A wildcard bind without one now warns. In mesh-serve, `start --advertise <public ip or host>`,
and joining a cluster (`--bootstrapNode`) from a wildcard bind without it is a hard error, since that
combination cannot work and fails silently.

**Not done, worth doing:** `getAddresses`' interface enumeration still silently returns loopback only
(the `eval('require')` in an ES module). With `advertiseHost` it no longer matters for a cluster that
sets it, but a node that does not will still advertise loopback and lose to the same collision on a
shared port.

---

## Done — the second remote call in a handler timed out, every time, at exactly the timeout

Found bringing up the first real nameserver on a second machine. `surfdns-nameserver`'s zone loader
runs inside `dns.listen` and makes two remote calls back to the `domains` node in sequence,
`dnsZone.find` then `dnsRecord.find`. The first answered; the second failed with `RPC Timeout ... after
10000ms`, on every attempt, while a probe making the same two calls as separate top-level calls got
both answered in ~25ms each. Not slowness, and not index creation (which was the first guess).

`executeRemote` used the caller's `correlationID` as the request's packet id, and `MeshNetwork` drops
any non-response packet whose id it saw in the last 10s as a duplicate. Every call in one chain shares
a correlationID, so the first remote call from inside a handler worked and each later one carried the
same id, was discarded at the receiver, and left its caller waiting out the full timeout. It also meant
a callee never saw the real chain id (it got the request id in that slot). Every earlier test made at
most one nested remote call per chain, which is why none of them noticed.

**Fixed** in `mesh` v4.2.1: a fresh id per remote call; the correlationID travels in meta. Regression
test (`RemoteChainCalls.spec.ts`, two real nodes over `WSTransport`) makes two sequential remote calls
from one handler -- it failed with the second timing out before the change and passes after.

**Worth knowing:** the failure inside `onStart` was *contained*. `dns.listen` threw, `runOnStart`
unloaded the part again, and the supervisor retried each tick rather than leaving a nameserver that
mounted but never listened looking healthy -- which is the reason `onStart` is all-or-nothing.

---

## Open — the nameserver reads every tenant's zones through calls that are scoped to one tenant

Found in the same session, hidden behind the bug above. `surfdns-nameserver`'s `loadFromDatabase`
calls `dnsZone.find` and `dnsRecord.find` on `surfdns-domains` with **no meta at all**. Both
collections are `scopedBy: 'tenantId'`, so a call with no resolvable scope is refused outright -- a
probe from a second node got `401 UNAUTHORIZED: Scoped collection "dnsZone" requires a resolved
"tenantId" scope` in ~5ms. It only appeared to work because, inside `onStart`, the calls inherit the
supervisor's ambient `meta: { tenant_id }`, which lets them through -- scoped to *that one tenant*.

So an authoritative nameserver started this way serves only the zones of whichever tenant the part
belongs to. Correct for a single-tenant demo, wrong for a platform: a nameserver's whole job is every
tenant's zones. The scoping is doing exactly what it is for; the loader is asking the wrong question
through the wrong door. Every node already has the database provider, so the framework's own
documented escape hatch for this (`Database.repo()`: unscoped, no hooks, "use `ctx.db()` unless you
specifically need every tenant's rows") is the likely shape -- a trusted infrastructure service reading
its own projection directly rather than a tenant-scoped cross-service call. Not started: it changes how
`surfdns-nameserver` is built and which of its tests mean anything, so it wants a decision.
