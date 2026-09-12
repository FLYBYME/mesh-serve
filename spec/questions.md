# The open questions

**Every unresolved decision from the other specs, in one place.** Each says which spec it belongs to,
what depends on it, and what happens if it is answered late.

They are grouped by deadline rather than by topic, because three of the groups stop being cheap on a
specific day.

| group | deadline | count |
| --- | --- | --- |
| **A** | before mesh 2 → 3, or permanent | 4 |
| **B** | before any collection is written | 4 |
| **C** | before the contract rename | 3 |
| **D** | structural — they decide how big this package is | 6 |
| **E** | smaller, and will otherwise be forgotten | 7 |

---

## A. Before mesh 2 → 3, or permanent

`surfdns/architecture/the-freeze.md`: *"the version bump is the last cheap breaking change."* These are
`defineCrud` semantics. **Answered after the bump, each costs a major version.**

### A1. Field-level visibility — surfdns **V2**

A collection must be able to declare a field unreadable, so `find` cannot return it. Today `visibility`
is per action, no gate subtracts a field, and the workaround is a hand-written contract per instance —
there have been five.

**Depends on it:** an operator holding `identity.user.find` at all; showing a person's name anywhere on
the platform; *who holds this role* being answerable. Every action on `user` is internal because one
field must never leave, so the whole collection is sealed.

**Half-answered already.** mesh now parses a projected read against a partial schema, so an output
schema that omits a field is no longer bypassed by `fields`. What remains is **declaring** it, and
refusing a projection that asks for it by name.

Where: [collections.md](./collections.md) §3.1.

### A2. Shaping a create input — mesh-serve **F10**

The same gap on the write side. `create` and `update` must write fields that `find` must not read, and
one declaration has to distinguish them. Today input and output schemas both derive from one base
schema, so there is nowhere to say it.

Where: [collections.md](./collections.md) §3.2.

### A3. Pagination as a default, not a parameter — surfdns **V1**, **V4**

Every generated `find` already takes `limit`, `offset`, `sort`, `search`. **Nothing has ever passed
one**, and nothing enforces a maximum. A public collection (**B1**) makes this urgent rather than tidy:
an unscoped read with no ceiling is the unbounded find this platform bans.

The question is whether the default and the maximum are `defineCrud`'s or the projection's. If they are
the projection's, every projection needs them and one will forget.

Where: [collections.md](./collections.md) §1, §3.3.

### A4. What else belongs in the bump

Relations and nested routing could be `defineCrud`'s or mesh-serve's. **Deciding is itself the
deadline** — anything left ambiguous lands on the wrong side by default, and `relations` is already
declared in mesh with nothing reading it.

Where: [collections.md](./collections.md) §3.4, §5.

---

## B. Before any collection is written

### B1. What gates writes on a public collection

Settled: a collection is scoped **or** public, and publishing is a contract that crosses between them.
**Not settled:** reads on a public collection are open by construction, so creates and updates belong
to an owner field that is now doing the work `scopedBy` did for free. What checks it, and where.

**Depends on it:** the catalog, which is the first public collection and the reason this exists.

Where: [collections.md](./collections.md) §3.3.

### B2. One name for the scope field — **and `scopedBy` is narrower than it looked**

**Answered in part by building it, 2026-09-11, and the answer changes two other specs.**

`scopedBy` cannot be used on a collection the scope is resolved *from*. A request arrives, the gate
reads the caller's memberships to decide which organization they are in, and `scopedBy: 'organizationId'`
refuses that read because no scope has been resolved yet. The node died on its first boot:

```
Scoped collection "membership" requires a resolved "organizationId" scope
```

Every path into it hits the same wall — bootstrap, the gate, and `identity.whoami`. **Membership is
narrowed by a hook instead**, to the caller's own rows, which is stricter than the scope would have
been: `scopedBy` lets a member read every membership in their organization, the hook lets them read
their own.

The same applies to `site`, for the reason [collections.md](./collections.md) §2 already gave and
nobody connected: *a collection that cannot be read without a scope cannot be on the serving path*.
Resolving a hostname happens before there is a caller. **Site is a public collection with an owner
field**, which makes **B1** block it too.

So the shape is: **`scopedBy` is for collections that hang off a resolved scope, never for the ones
that produce it.** Still open is the original question — one name, `tenantId` or `organizationId` —
now narrowed to the collections that genuinely are scoped. `tenantId` and `organizationId` are the
same value under two names, because `site` declared one and `membership` declared the other and the
gate had to carry both into every handler. **A migration, not a decision** — and the slice writes
`organizationId` everywhere, so the migration is smaller than it was.

Where: [identity.md](./identity.md) §8, [collections.md](./collections.md) §1.

### B3. Asking for a hidden field: refusal or silent drop

Recorded as a refusal naming the field, on the grounds that a caller who asks has either made a mistake
or made an attempt. Not built, and the opposite is defensible for a projection that is merely optimistic
about which columns it wants.

Where: [collections.md](./collections.md) §3.1.

### B4. Where a repository credential lives

A private repository needs one. A collection readable by an organization is not where it goes, so the
row carries a reference — and nothing says what it references. **New with the repository collection**,
and it has to be answered before that collection is written rather than after somebody has put a token
in a field.

Where: [building.md](./building.md) §2, §8.

---

## C. Before the contract rename

### C1. The rename itself

174 contracts, flat `domain.action`, moving to two rooted hierarchies: `identity.*` and `serve.*`, with
a tenant's own contracts outside both. **Mechanical and large.**

**Everything in [identity.md](./identity.md) §4 onward depends on it** — wildcards mean nothing without
a hierarchy — and it deletes `PLATFORM_DOMAINS`, the 23-name list maintained by hand.

### C2. Revocation semantics

A grant is a transfer: you may only grant what you hold. So if A grants B a permission and A later loses
it, B's grant descends from nothing. **Cascade, or refuse to revoke what has been passed on.** Either is
defensible; silence is not.

Where: [identity.md](./identity.md) §6.

### C3. Where the root wildcard lives

`**` enters the system once, at first boot. A role that cannot be edited, a flag on the first account, or
something else. **It is the only place authority originates**, so wherever it is put is the thing an
audit has to start from.

Where: [identity.md](./identity.md) §6.

---

## D. Structural, and they decide what this package is

### D1. Where bootstrap lives

A cluster with no sites cannot be reached: resolution is connection → site, so on a fresh node there is
no route to sign in and no way to create the first site. The previous answer was the node serving one
site for itself, in **414 lines reaching into 33 foreign contracts** — the single reason serving
appeared to depend on everything.

**This is the one with no obvious home**, which is exactly why it got filed under whichever domain
needed it.

Where: [README.md](./README.md), [serving.md](./serving.md) §3.

### D2. Whether a projection is a part

If protocols are an open set — cdn, api, mcp, git-http, smtp, imap, ftp — then adding one should not mean
editing this package. A projection has a fixed shape: resolve a site, resolve an account, express what it
can, pass refusals through. **That shape is a contract somebody could implement from outside.**

**Answering yes makes this package much smaller.** Answering no means every protocol is a release of
mesh-serve.

Where: [serving.md](./serving.md) §7, §10.

### D3. Whether building belongs here at all

`build` has the fewest ties to serving: it produces artifacts and a release row, and serving reads them.
It could be a separate service a node runs, or does not.

Where: [building.md](./building.md) §9.

### D4. Whether approval belongs here at all

Eleven contracts, self-contained, calls nothing, and gates destructive agent calls. **A real need, and
not obviously this package's.**

### D5. Ports and listeners as records

Every projection needs an address to listen on, and those are facts about a node. That is
[fleet.md](./fleet.md)'s territory, and **the seam between fleet and serving is not drawn** — the ports
table would live in fleet while the thing that binds them lives in serving, and nothing says how they
meet.

### D6. Whether provisioning belongs in fleet

Creating a machine is a different act from recording that one exists, and it is the part that reaches a
cloud provider — credentials, billing, an API that is not ours. **Recording and reconciling could stay
while provisioning leaves.**

Where: [fleet.md](./fleet.md) §5.

---

## E. Smaller, but they will be forgotten

### E1. `transferOwnership` exists in the store and no contract calls it

An operator can create the account to hand an organization to, and cannot finish the handover — which is
the operator's whole job.

### E2. Changing your own email has no contract

Blocked by **A1**: `user.update` is internal and cannot be exposed while the row carries a password hash.
The user's own sketch has `identity update --email` in it, so this is a request, not a nicety.

Where: [cli.md](./cli.md) §1.

### E3. Whether `_describe` is exempt from the provisional refusal — **answered**

**Closed 2026-09-11 by a test written to assert the ordering.** The answer is broader than the
question: **public is public, whoever is asking.** The provisional check runs *after* the public
case, not before it.

The question framed this as an oddity. It is worse than odd. `identity.sign_out` is public, so an
unclaimed account **could not sign out**; `identity.ticket_issue` is public, so it could not sign in
again either. A restriction meaning *do nothing until you set a password* must not also mean *and you
may not use the door you came in through*.

Where: [serving.md](./serving.md) §6, and `test/gate.test.ts`.

### E7. A JSON-shaped parameter cannot survive a query string

**New, 2026-09-11.** Every generated `find` takes `query`, a record, and `limit`, a number — and over
GET both arrive as text, so `?query={"userId":"x"}` failed its own schema with *"Expected object,
received string"*.

**Part of the reason nothing passes these parameters is that nothing could.** The projection now
parses a value that looks like JSON, a number or a boolean and leaves everything else alone —
narrowly, so `127.0.0.1` stays a string. Whether that belongs in the projection or in the input
schema is the open part, and it is **A4**-shaped: decided late, it lands on the wrong side.

### E4. Where a bare repository path fits

Local development imports from `/home/…/.git-remotes/x.git`, a reference that resolves on exactly one
machine. **Honest for a laptop, wrong for a fleet.**

Where: [building.md](./building.md) §8.

### E5. What a telemetry sink writes to

Decided once and injected, rather than discovered at start through a cast into an invented shape that
swallows its own failure.

Where: [fleet.md](./fleet.md) §3.

### E6. How the first-boot banner survives the log stream — **answered**

**Closed 2026-09-11.** It is printed once and is not recoverable, and it was scrolling past under one
log line per registered tool — around sixty of them. **A message that has scrolled past has not been
shown.**

Identity now hands the banner to whoever started the node instead of printing it, and the launcher
prints it after everything is up, immediately above the command it tells you to run. That also fixes
the worse case found alongside it: a startup that failed *after* the banner — a port already in use —
left somebody holding a password above a stack trace, on a cluster that was not running.

Where: [cli.md](./cli.md) §3, and `bin/node.mjs`.

---

## What is already decided

So they are not reopened by accident. Each is argued where it lives.

| | where |
| --- | --- |
| A connection resolves to a site; no default site, ever | [serving.md](./serving.md) §3 |
| Site resolution is a chain: protocol host, SNI, address domain, port | serving §3 |
| A hostname is normalised; `localhost` and `127.0.0.1` stay distinct | serving §3 |
| `x-forwarded-host` is trusted by deployment, never by guess | serving §3 |
| Each protocol turns its own credential into a ticket | serving §4 |
| A token carries `agent`, so a program is never mistaken for a person | serving §4 |
| SMTP submission and relay are two projections, never one listener | serving §4 |
| The coarse gate always runs; a hook may only narrow | serving §2 |
| An exposure entry declares exactly one gate, or does not compile | serving §5 |
| A site is narrower than a cluster, and that is why two tenants are safe | serving §9 |
| One error shape; `declared` is explicit, never inferred from a status | [errors.md](./errors.md) §2 |
| Read the structure, not the identity — `instanceof` fails across copies | errors §3 |
| One mechanism for permissions: account and membership, not levels | [identity.md](./identity.md) §2 |
| Patterns are `*` and trailing `**`, no negation, unioned | identity §3 |
| Two roots, `identity.*` and `serve.*`; `serve`, not `platform` | identity §4 |
| Uniform depth, `root.noun.action` | identity §4 |
| A grant is a transfer — you may only grant what you hold | identity §6 |
| Role inheritance is same-scope and acyclic, checked at write | identity §5 |
| `login` answers per account, with scope as a column | identity §7 |
| A scope is resolved by the gate, never supplied by the request | identity §8 |
| Naming an organization you are not in answers 404, not 403 | identity §8 |
| A ticket is a revocable row; revocation is polled by epoch | identity §9 |
| Route over query over body, because the route was verified | [collections.md](./collections.md) §4 |
| A collection is scoped or public; publishing is a contract | collections §3.3 |
| Hidden fields go in `defineCrud`, not a wrapper | collections §3 |
| `:organizationId` is an assertion to verify; `:repositoryId` is a parent | collections §3.4 |
| Four things, not nine | [README.md](./README.md) |
| One repository holds many parts, scoped to an organization | [building.md](./building.md) §2 |
| A version is not an artifact; a release is not a deployment | building §1 |
| A composition is refused at compose time, not in a browser | building §5 |
| Anything that clones or bundles declares its own timeout | building §7 |
| Telemetry is part of fleet | [fleet.md](./fleet.md) §3 |
| Fleet is independent of serving and building | fleet §6 |
| Desired and observed are different fields, and the gap is the product | fleet §4 |
| The CLI is generated from the descriptor and opens no database | [cli.md](./cli.md) §1 |
| A password is never read from argv | cli §4 |
