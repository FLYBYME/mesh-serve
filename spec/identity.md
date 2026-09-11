# Identity

**Who is calling, and in which organization.** Everything in [serving.md](./serving.md) resolves
through these two questions, and every scoped collection is confined by the second answer.

Identity is the one domain in this repository that calls nothing but itself. That is worth keeping:
it is a dependency of everything and depends on nothing, so it can be reasoned about alone.

## 1. The nouns

| | is | is not |
| --- | --- | --- |
| **account** | a person or a machine that can hold a ticket | a member of anything by itself |
| **organization** | who owns things: sites, repositories, parts | a group of permissions |
| **membership** | an account's place in one organization, with a role | the account |
| **role** | a named set of grants, and a row, not an enum | a level |
| **grant** | one `(role, contract)` pair — this role may call this | a list on a role |
| **ticket** | a bearer credential, revocable, with an expiry | a session object |

**A role is a row and a grant is a row**, because the interesting queries run the other way: *which
roles can call this contract* is the question an operator actually asks, and an array on a role
cannot answer it.

## 2. Scope is an organization, and it has one name

The resolved scope is an **organization id**. Never a user id.

It currently reaches a handler under two names — `tenant_id` and `organizationId` — set from the
same value, because a scoped collection is narrowed by *its own* field name and two schemas
disagreed: `site` declares `tenantId`, `membership` declares `organizationId`. Both spellings have
to be present or one of those collections stops resolving.

**That is one value written twice to paper over a naming disagreement, and it should be one name.**
Picking it is a migration, not a decision, and it is open.

## 3. How a scope is resolved

```
ticket ──► account ──► memberships ──► one organization
                            ▲
                   host, or an explicit selection
                   checked against the memberships
```

- **One membership**: that is the scope. Nothing to choose.
- **Several**: the site's own organization decides, if the caller is a member of it. A request on
  `flowboard.localhost` means Flowboard Inc, because that is whose site it is.
- **An explicit selection** — a header, a verified path segment — chooses among the caller's
  memberships and is checked against them. It narrows and cannot add.
- **None that match**: no scope. Every scoped read then refuses, and *that is correct*. A caller
  outside every organization is not a caller with an empty result set.

The mechanism matters as much as the rule: **the gate returns the scope**. A request never supplies
one. This is the whole reason the gate returns a value rather than validating one the request
carried.

## 4. Two kinds of standing, enforced apart

- **Cluster standing** is on the account: `operator`. It is a bootstrap-and-handover role — bring a
  cluster up, seed a hostname, hand the organization over, step out.
- **Organization standing** is on the membership: `owner`, and whatever else an application defines.

**An operator is not automatically an owner of anything.** They are separate because the operator
who builds a cluster is not the tenant who runs on it, and the day those two are one check is the
day an operator can read every tenant's data by accident.

A gate is a **floor, not a band**. `admin` does not satisfy an `operator` gate; they are separate
checks. A gate that is looser than its handler is a promise the platform will not keep.

## 5. Roles are data, and bounded twice

Roles and grants are rows, so an application can define its own. Two bounds stop that becoming a way
to grant yourself the platform:

- **A seed may grant only what the site exposes.** You cannot grant a contract the site does not
  serve.
- **A seed may never grant a platform domain.** Identity, fleet, builder and the rest are off the
  table regardless of what a release asks for.

**Role inheritance is same-scope only, with no cycles**, checked when written and honoured when
read. An organization role cannot inherit a cluster role; that is the rule that keeps §4 true.

**A grant-writing contract is gated by a level, never by a grant.** A caller who could be granted
the right to write grants could grant themselves anything. That circularity is what the coarse
levels exist to break.

## 6. What cannot be exposed, and why it matters here

`user` carries a password hash. A generated find returns the row, and visibility is per action, so
**no gate subtracts a field** — which is why every `user` action is internal and why nothing in this
platform can turn a user id into a name.

This is the platform's most-repeated gap. It is six instances deep: the console shows ids, members
cannot be named, and *"who holds this role"* is unanswerable.

The fix is a collection that can declare a field hidden and enforce it at the projection as well as
the output, which is [collections.md](./collections.md). Until then, *a screen that quietly showed
ids as though that were the design would delete the evidence*.

## 7. What must be true

- **A provisional account can do exactly one thing: set its own password.** Checked ahead of every
  level including `public`, in one place, so no contract can forget to ask. A platform where nothing
  works until you claim the account is one where it gets claimed in the first minute.
- **Changing a password ends other sessions.** A credential that outlives the reason it was changed
  is not a credential that was changed.
- **A ticket is opaque and revocable.** Never a signed claim the server cannot withdraw.
- **A password is never read from argv**, where it is visible in `ps` and lands in a shell history.

## 8. Open

- **One name for the scope** (§2).
- **Field-level visibility** (§6), which unblocks showing a person's name anywhere.
- **`transferOwnership` exists in the store and no contract calls it.** An operator can create the
  account to hand an organization to and cannot finish the handover, which is the operator's actual
  job.
- **Changing your own email has no contract at all**, because `user.update` is internal and cannot
  be exposed for the reason in §6.
