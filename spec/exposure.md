# Exposure

What goes on the internet, and the discipline that keeps it small.

**Status: Decided. The api module is unwritten.**

---

## 1. Generate everything, expose almost nothing — **Decided**

`defineCrud` produces ten actions from a schema — `find · find_one · count · get · resolve · create ·
create_many · update · replace · delete` — and mounts them on the broker. That is right: any service
on the mesh may ask what a site is made of.

**What is reachable from outside the mesh is a separate and much smaller decision**, made per site.

### This is the specific way 100,000 lines went wrong

In paas, `user.find`, `organization.get` and friends were reachable as though public, and a great many
calls had **no bounds**. That is not quite an authorization bug, and calling it one hides the real
shape: authorization can refuse a *caller*, but it cannot narrow a *result set*. An unbounded `find`
has no notion of the caller's scope, so `organization.find` returns every organization there is and
nothing in the contract could have said otherwise.

The plumbing for half of it exists and is not joined up: the api's `authorize` hook already takes a
requested scope and returns a resolved one, and `defineCrud` has no idea that exists. The missing join
is *"this collection is scoped by this field, and a find is always within the caller's resolved
scope."*

Until that exists the rule is a discipline, and it is not optional:

> **Never expose an unbounded `find`.**

`site.find` is generated and must never be exposed. Enumerating every hostname on the platform is
exactly the shape of the mistake.

## 2. Explicit contracts wrap CRUD, they do not replace it — **Decided**

CRUD is used idiomatically and never hooked. A contract that carries a side effect or an invariant —
issuing a ticket, registering a user and their organization and their owner membership as one act —
does the work and then **writes the document through the normal CRUD path**.

Consequential state — anything a reconciler writes, anything observed — is written only by an explicit
contract or the owning reconciler. Enforcement is *which contracts are exposed*, not wrapping CRUD.

**`mesh-identity` is the counter-example and it is in this repository.** Zero `defineCrud`, eight
hand-written contracts, and a 160-line store interface hand-rolling `createUser`, `getUser`,
`updateUser`, `createOrganization`, `createMembership`, `listRoles`, `upsertRole`, `addGrant` — twenty
methods that are literally what `defineCrud` generates, across seven record types.

The line count is the smaller problem. **Those records are closed.** They are reachable only through
the eight accessors somebody thought to write, so every new question needs a new contract *and* a new
store method. That is how a service becomes a bottleneck. It needs rewriting on CRUD before four more
services are copied from it.

## 3. A contract is named, not imported — **Decided**

`ExposeEntry` held a live `ToolContract`, which is why an exposure list had to be TypeScript and why a
UI repository had to ship a service half to have one.

`"domains.zone_create"` is a name. Names are data, resolvable through the contract registry — which,
per the framework's own measurements, is populated at import time and **read only by codegen**, which
is exactly this use.

**What is lost:** a typo used to be a compile error. Now it is a 404, indistinguishable from a route
that was never meant to exist.

**How it is recovered:** the site names the *package* as well as the contracts, and
[the build verifies](./building.md#5-verification-happens-at-build-time) that the package really
exports them. Static, no cluster, and it hands the generator its schemas at the same time.

## 4. A part gets its types from a committed descriptor — **Decided in shape**

Types need schemas; schemas live in the service; a part repository has no service. So the descriptor
has to come from somewhere, and only one option lets an editor work:

- **from a running API** — your editor now depends on a server being up
- **from the catalog** — the platform must be running to open a file
- **from a committed `descriptor.json`** ✓

The lockfile pattern, for lockfile reasons. The editor works offline. CI is reproducible with nothing
running. **A contract changing is a reviewable line in a pull request** rather than a surprise at
runtime. And the exposure hash in that committed file is a durable record of what this part was built
against.

```
mesh-web descriptor --from http://127.0.0.1:5005   # occasionally: refresh
mesh-web client                                     # anytime: descriptor.json → src/generated/
```

**The generator belongs in `mesh-web`**, not here, and not for convenience: a part repository already
depends on the browser framework and must never depend on the server. Putting it here would make every
UI repository install a web server to get types.

One file, not three. The descriptor already carries method, path, gate and JSON Schema per call. The
base URL is not in generated code; it is `data-api`, baked by whoever generates the page.

## 5. The exposure hash — **Decided, keep at all costs**

A hash of everything a site exposes. The API reports it, the generated client carries it, and a
mismatch is an error rather than a confusing 404 three calls later.

> A client generated from one exposure and pointed at an API serving another is a lie the compiler
> vouches for, which is worse than no types at all.

With composition assembled from independently versioned parts, this becomes **more** load-bearing, not
less: it is the only thing standing between a stale part and a silently wrong call.

## 6. Routes come from the record — **Decided**

The api resolves **Host → site → `mesh[]` → routes**, exactly as the cdn resolves Host → site →
artifact. Same cache, same invalidation, same claim that any node can serve any site. One serves
files, the other serves calls.

This is what the module already claims to be — *across requests it holds exactly two things, the
exposure map and the ticket cache* — with the map keyed by host.

And it makes the gate **per site**: one site may expose `domains.zone_find` as `public` while another
requires `user`. A single global list could not express that, and who may call a thing is a
deployment's decision rather than a contract author's.

The record carries `key` and the gate. **Schemas come from the broker's registry**, populated when the
owning module mounts. The api joins the two and hashes the result.

## 6a. How the module is shaped — **Decided 2026-09-06**

The api is **the cdn's twin**. Both resolve `Host → site`, both bind a port, both cache the same
records with the same invalidation. One serves files and the other serves calls, and that is the only
difference worth a separate module.

So it takes the shape the other three services already have — `contracts/`, `schema/`, `methods/`,
`tools/`, one `api.service.ts` — with one thing that makes it unlike them:

> **It owns no collections.**

What a site exposes is `site.mesh`, owned by the cdn. Tickets are identity's. The exposure hash is
derived from the two. So `api.service.ts` calls `mountCrud` **zero times**, and every record it reads
comes through another service's contract. That is not an omission; it is what *the api is a
projection* means, and if it ever grows a collection the first question is which service should have
owned it.

### What survives from mesh-api, and what does not

| | |
| --- | --- |
| `auth/gate.ts` | **keep.** `SCOPE_HEADER`, the caller model, and the argument for one header rather than four caller-controlled names in three places. |
| `auth/tickets.ts`, `revocations.ts` | **keep.** The revocation-epoch poller is subtle and correct. |
| `server/input.ts` | **keep.** Coercing a query string to a zod schema is fiddly and done. |
| `server/rest.ts`'s *inner* logic | **keep** — error-to-status mapping, `DeclaredFailure`, the exposure header. |
| `server/rest.ts`'s *structure* | **goes.** It takes `expose: ExposeEntry[]` and mounts one express route per contract **at boot**. A fixed route table known at startup is exactly what routes-from-the-record replaces: a route now depends on which hostname asked. |
| express | **goes.** The cdn proved `node:http` is enough for *resolve a host, look up a table, answer*, and a framework for that is a dependency earning nothing. |
| `createWebServer` | **goes.** It gates on `instanceof WebServiceModule`, the class model this repository left. |
| `module/exposure-collection.ts` | **goes as a collection, stays as an idea.** It kept a heartbeat of which node exposes what; the site record answers that now without a second source of truth. |

### The request path

```
Host → site → route table → gate → broker.call(key, input, { meta }) → response
```

Every step is a lookup except the gate, and the gate is where the caller stops being anonymous: a
ticket resolves to a principal, `x-organization` resolves to a scope, and both go into `meta` so the
handler on the other side of the broker sees who is asking.

The route table is **derived from the record, cached with it**. `site.mesh` names contract keys; the
broker's registry has each contract's `rest.method` and `rest.path` and its schemas. The api joins the
two — which is also the only place both halves exist, and therefore where the exposure hash is
computed.

### The one thing this cannot fix

**Scope has to reach `defineCrud`, and that is a change to mesh rather than to this module.**

The api can resolve a caller's organization and put it in `meta`. It cannot make a generated `find`
use it: the query is built inside the framework's CRUD path, which knows nothing about a scope. So the
api can refuse a *caller* and still hand back every row.

Writing the filter here instead would be worse than not having it — a second copy of authorization,
sitting beside a CRUD path that bypasses it, is how a rule comes to be true on the routes somebody
remembered.

The shape the framework needs is a collection declaring what scopes it: `defineCrud('site',
SiteSchema, { scopedBy: 'tenantId' })`, so `find` is *always* within the caller's resolved scope and
an unscoped one is unrepresentable rather than discouraged. Until then, [§1](#1-generate-everything-expose-almost-nothing)'s
rule stands as a discipline — and a discipline is what paas had.

## 7. Three credential planes, never confused — **Decided**

| plane | who | credential |
| --- | --- | --- |
| **user** | a person or their token, on the web, CLI or API | user credential, org-scoped |
| **bootstrap** | a node, once, at startup | node credential, placed by provisioning |
| **mesh** | node ↔ node thereafter | mesh membership |

**A node must never hold a user credential.** The user plane authorizes an assignment to be *written*;
it is not what a node presents. A compromised edge node holding an org-scoped user token would hold
power over the whole organization.
