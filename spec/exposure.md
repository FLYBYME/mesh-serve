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

## 7. Three credential planes, never confused — **Decided**

| plane | who | credential |
| --- | --- | --- |
| **user** | a person or their token, on the web, CLI or API | user credential, org-scoped |
| **bootstrap** | a node, once, at startup | node credential, placed by provisioning |
| **mesh** | node ↔ node thereafter | mesh membership |

**A node must never hold a user credential.** The user plane authorizes an assignment to be *written*;
it is not what a node presents. A compromised edge node holding an org-scoped user token would hold
power over the whole organization.
