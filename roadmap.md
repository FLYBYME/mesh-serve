# Roadmap

Written 2026-09-15, after rebuilding mesh-serve's own CLI on real generated clients and then, live,
hand-running a fresh install through it. That second part is what actually produced everything below
— every item here was found by using the thing, not by reading it. Nothing here is settled; the
**Open** sections are live disagreements-with-myself as much as they are plans.

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

## No longer blocked, not yet done

- **Regenerating `mesh-operator/src/console/generated/api.ts` for real.** It's still the old
  JSON-Schema-to-`interface` output (no zod, imports `@flybyme/mesh-web` not `/net`) from before this
  session's generator rewrite. The bootstrap gap that blocked this is fixed — there's now a real
  `serve.api` row (`Platform`'s bootstrap api) an operator can `serve.expose.add` the console's wanted
  contracts onto and generate a real client from. Not done yet, just unblocked.
- **The console port itself** (`contract.ts`, `index.ts`, `views/*.ts`) — `cx.mesh.call` needs the
  Result→throw update, `cx.models('site')`/`'membership'`/`'release'` need to become
  `cx.models('serve.cdn')`/`'identity.membership'`/`'serve.release'` (collection names derive from
  the real `${domain}.find` action, not an arbitrary short name), and the whole `seedSite` command is
  built around a `site.seed` contract that no longer exists — mesh-serve only has the separate
  primitives now (`serve.repo.create` → `serve.part.create` → `serve.artifact.requestBuild` →
  `serve.composition.create`/`.compose` → `serve.cdn.create` → `serve.cdn.deploy` → `serve.expose.add`).
  Still blocked on `defineCommand`/`defineView` not existing, if that's the direction taken.
