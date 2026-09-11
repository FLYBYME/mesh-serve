# The open questions

**Every unresolved decision from the other specs, in one place.** Each says which spec it belongs to,
what depends on it, and what happens if it is answered late.

They are grouped by deadline rather than by topic, because three of them stop being cheap on a
specific day.

---

## A. Before mesh 2 → 3, or permanent

`surfdns/architecture/the-freeze.md`: *"the version bump is the last cheap breaking change."* These
are `defineCrud` semantics. Answered after the bump, each costs a major version.

### A1. Field-level visibility — surfdns **V2**

A collection must be able to declare a field unreadable, so `find` cannot return it. Today
`visibility` is per action, no gate subtracts a field, and the workaround is a hand-written contract
per instance — there have been five.

**Depends on it:** an operator holding `identity.user.find` at all; showing a person's name anywhere
on the platform; *who holds this role* being answerable.

**Half-answered already.** mesh now parses a projected read against a partial schema, so an output
schema that omits a field is no longer bypassed by `fields`. What remains is declaring it, and
refusing a projection that asks for it by name.

### A2. Shaping a create input — mesh-serve **F10**

The same gap on the write side. `create` and `update` must write fields that `find` must not read,
and one declaration has to distinguish them.

### A3. Pagination as a default, not a parameter — surfdns **V1**, **V4**

Every generated `find` already takes `limit`, `offset`, `sort`, `search`. Nothing passes them, and
nothing enforces a maximum. A public collection (§B1) makes this urgent rather than tidy: an unscoped
read with no ceiling is the unbounded find this platform bans.

### A4. What else belongs in the bump

Relations and nested routing could be `defineCrud`'s or mesh-serve's. **Deciding is itself the
deadline.** Anything left ambiguous lands on the wrong side by default.

---

## B. Before any collection is written

### B1. What gates writes on a public collection

Settled: a collection is scoped **or** public, and publishing is a contract that crosses between
them. Not settled: reads on a public collection are open by construction, so creates and updates
belong to an owner field that is now doing the work `scopedBy` did for free. What checks it, and
where.

**Depends on it:** the catalog, which is the first public collection and the reason this exists.

### B2. One name for the scope field

`tenantId` and `organizationId` are the same value under two names, because `site` declared one and
`membership` declared the other and meta had to carry both. A migration, not a decision — but it gets
harder per collection written.

### B3. Asking for a hidden field: refusal or silent drop

Recorded as a refusal naming the field, on the grounds that a caller who asks has either made a
mistake or made an attempt. Not built.

---

## C. Before the contract rename

### C1. The rename itself

174 contracts, flat `domain.action`, moving to two rooted hierarchies: `identity.*` and `serve.*`,
with a tenant's own contracts outside both. Mechanical and large.

**Everything in [identity.md](./identity.md) depends on it** — wildcards mean nothing without a
hierarchy — and it deletes `PLATFORM_DOMAINS`, the 23-name list maintained by hand.

### C2. Revocation semantics

A grant is a transfer: you may only grant what you hold. So if A grants B a permission and A later
loses it, B's grant descends from nothing. **Cascade, or refuse to revoke what has been passed on.**
Either is defensible; silence is not.

### C3. Where the root wildcard lives

`**` enters the system once, at first boot. A role that cannot be edited, a flag on the first
account, or something else. It is the only place authority originates.

---

## D. Structural, and they decide what this package is

### D1. Where bootstrap lives

A cluster with no sites cannot be reached: resolution is connection → site, so on a fresh node there
is no route to sign in and no way to create the first site. The previous answer was the node serving
one site for itself, in 414 lines that reached into five other domains — which is the single reason
serving appeared to depend on everything.

**This is the one with no obvious home**, which is why it got filed under whichever domain needed it.

### D2. Whether a projection is a part

If protocols are an open set — cdn, api, mcp, git-http, smtp, imap, ftp — then adding one should not
mean editing this package. A projection has a fixed shape: resolve a site, resolve an account,
express what it can, pass refusals through. That shape is a contract somebody could implement from
outside.

**Answering yes makes this package much smaller.** Answering no means every protocol is a release.

### D3. Whether building belongs here at all

`build` has the fewest ties to serving: it produces artifacts and a release row, and serving reads
them. It could be a separate service a node runs, or does not.

### D4. Whether approval belongs here at all

It is self-contained, calls nothing, and gates destructive agent calls. A real need, and not
obviously this package's.

### D6. Whether provisioning belongs in fleet

Creating a machine is a different act from recording that one exists, and it is the part that reaches
a cloud provider — credentials, billing, an API that is not ours. Recording and reconciling could
stay while provisioning leaves.

### D5. Ports and listeners as records

Every projection needs an address to listen on, and those are facts about a node. That is
[fleet.md](./fleet.md)'s territory and the seam between fleet and serving is not drawn.

---

## E. Smaller, but they will be forgotten

### E1. `transferOwnership` exists in the store and no contract calls it

An operator can create the account to hand an organization to, and cannot finish the handover —
which is the operator's whole job.

### E2. Changing your own email has no contract

Blocked by A1: `user.update` is internal and cannot be exposed while the row carries a password hash.

### E3. Whether `_describe` is exempt from the provisional refusal

A provisional account is refused ahead of every check, deliberately. So a site's description is
readable with no credential, readable with a garbage credential, and refused with a real provisional
one — being signed in as the account the platform just created for you is the only state in which the
public endpoint refuses.

### E4. Where a bare repository path fits

Local development imports from `/home/…/.git-remotes/x.git`, a reference that resolves on exactly one
machine. Honest for a laptop, wrong for a fleet.

### E5. What a telemetry sink writes to

Decided once and injected, rather than discovered at start through a cast into an invented shape.

---

## What is already decided

So they are not reopened by accident. Each is argued where it lives.

| | where |
| --- | --- |
| A connection resolves to a site; no default site, ever | [serving.md](./serving.md) §4 |
| Site resolution is a chain: protocol host, SNI, address domain, port | serving §4 |
| Each protocol turns its own credential into a ticket | serving §5 |
| SMTP submission and relay are two projections, never one listener | serving §5 |
| One mechanism for permissions: account and membership, not levels | [identity.md](./identity.md) §2 |
| A grant is a transfer — you may only grant what you hold | identity §5 |
| Two roots, `identity.*` and `serve.*`; `serve`, not `platform` | identity §3 |
| Uniform depth, `root.noun.action` | identity §3 |
| `login` answers per account, with scope as a column | identity §6 |
| A scope is resolved by the gate, never supplied by the request | identity §7 |
| Route over query over body, because the route was verified | [collections.md](./collections.md) §2 |
| A collection is scoped or public; publishing is a contract | collections §2 |
| Hidden fields go in `defineCrud`, not a wrapper | collections §2 |
| Four things, not nine | [README.md](./README.md) |
| Telemetry is part of fleet | [fleet.md](./fleet.md) §2 |
| Fleet is independent of serving and building | fleet §4 |
| One repository holds many parts | [building.md](./building.md) §2 |
