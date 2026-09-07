# mesh-serve, for someone arriving cold

**The platform**: catalog, builder, cdn, api, identity. ~12,700 lines of TypeScript.

This file exists because every dispatch was re-deriving the same facts. Measured across the
transcripts: `src/identity/store.ts` opened 33 times, `spec/roadmap.md` 24, `src/api/api.service.ts`
23, and two files inside `node_modules/@flybyme/mesh` 21 times between them. **Read this first; it is
the index, not the documentation.**

## The five services

| | what it does | start here |
| --- | --- | --- |
| `catalog` | `part` and `partVersion`. A version is **immutable** and bound to a commit. | `src/catalog/tools/publish.ts` |
| `builder` | clone a commit, esbuild, one artifact per part, cached by input hash | `src/builder/tools/build_start.ts` |
| `cdn` | binds a port. Host → site → release → artifact, page generated per request | `src/cdn/cdn.service.ts` |
| `api` | HTTP. Routes from the site record, gated per site | `src/api/api.service.ts` |
| `identity` | users, orgs, memberships, roles, tickets. On `defineCrud` since A4. | `src/identity/module.ts` |

## Six things that are true and cost an hour to rediscover

**A part artifact never contains the kernel.** The framework is an esbuild external resolved by the
import map, so upgrading a site's kernel is a **recompose**, not a rebuild.

**A release is site-independent.** `tenantId`, `name` and `composedAt` are deliberately not inputs to
its hash — two organizations composing the same set have composed the same thing. This is why
per-site facts (gates, exposure) cannot live on a release; D4 is the worked example.

**`scopedBy` confines every generated read and write** (mesh v2.2.0). `find` is scoped, `create`
stamps the field, `update` cannot reparent a row, a cross-scope `get` answers **404 not 403**. The
scope comes from `meta.user[<scopeField>]`, resolved by the api's `authorize` hook — see
`bin/node.mjs`. **Without that hook every scoped collection answers 401 to everybody**, which is how
it failed the first two times.

**Public read paths are a second door, and there are exactly two.** `cdn.resolve_site` reads the
collection directly because a browser has no organization, and `identity.whoami` reads memberships
across tenants because a user picks an organization *after* signing in. Both are four lines with a
stated invariant. *A door that opens into the same locked room is not a second door* — but the count
is the property worth keeping. **Do not add a third without arguing for it in your report.**

**An artifact is content, never a location.** There is deliberately no `path`, `dir` or `filePath`
field anywhere in `ArtifactSchema`. Durability is *rebuild*, not replication: an edge disk is a
cache and git is the archive.

**Errors that answer 404 where 403 would be natural are deliberate.** Whether a part, an organization
or a site exists is not something an unrelated caller gets to confirm by probing.

## The two documents to read before changing anything

- **`spec/roadmap.md`** — every item, what blocks it, and what is already done. **Check whether your
  task is already closed**; it has happened, because a superseded entry was left unchecked below its
  replacement.
- **`spec/unread.md`** — the reader audit. Its rule is **"name the reader, or do not add the field"**.
  If you add a field, a manifest entry or a state enum, either name the production code that reads it
  or put it in this file. A comment asserting an invariant is the cheapest place for one to quietly
  not exist.

## Conventions

Zero `as any`, zero `as never`, **zero casts** — this repository exists because its owner nearly
rewrote MoleculerJS for type safety. A cast is a bug, not a style nit.

`resolve({ id })` for a lookup by id, `find_one({ query })` for any other key. Never `get` (it
throws), never `find` + `limit: 1`.

Never pass an optional field as explicit `undefined` in a create or update — it round-trips through
mongo as `null` and fails the schema on read. Spread it in conditionally.

## Running it

```bash
npm run build                      # generate + tsc
npm test                           # needs a real mongo, see below
node bin/node.mjs --ws 4001 --cdn 8080 --api 5005 --db mesh-serve-live
```

**`--db` matters.** The default is `mesh-serve` and the live data is in `mesh-serve-live`; starting
without it produces an empty, working-looking platform. Mongo runs in the `mongodb-local` container.
