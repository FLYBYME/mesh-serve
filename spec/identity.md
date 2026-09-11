# Identity

**Who is calling, and what they may do.** Everything in [serving.md](./serving.md) resolves through
this, and every scoped collection is confined by it.

Identity is the one domain in this repository that calls nothing but itself. That is worth keeping:
it is a dependency of everything and depends on nothing, so it can be reasoned about alone.

**Status: being redesigned, 2026-09-11.** §3 onward is the new model and is not what the code does.
§9 lists what has to be answered before it can be built.

## 1. The nouns

| | is | is not |
| --- | --- | --- |
| **account** | a person or a machine that can hold a ticket | a member of anything by itself |
| **organization** | who owns things: sites, repositories, parts | a group of permissions |
| **membership** | an account's place in one organization, carrying roles | the account |
| **role** | a named set of permissions, and a row | a level |
| **permission** | a pattern matching contracts — `identity.user.find`, `build.part.*` | a contract |
| **ticket** | a bearer credential, revocable, with an expiry | a session object |

## 2. There is one kind of standing, held in two places

**This is the change.** Today `operator` is checked outside the permission system: a coarse level,
tested ahead of everything, that no role can express and no grant can produce. It is a second
mechanism, and a second mechanism is a second set of bugs.

An account holds permissions. A membership holds permissions. **Same mechanism, two places it can be
attached:**

```
account ──── holds roles ──────────────► permissions that apply everywhere
   │
   └──── membership in org A ─ roles ──► permissions that apply in org A
   └──── membership in org B ─ roles ──► permissions that apply in org B
```

So an operator is an ordinary account that happens to hold `identity.user.find` and
`identity.user.create`, and the `user` role does not. Nothing about the *check* is special; only the
grants differ.

Two coarse states survive, and only because they are about the caller existing rather than about
what they may do:

- **public** — no caller at all. A browser fetching a page.
- **authenticated** — some caller. Used only where the identity matters and the permission does not:
  reading your own account, setting your own password, signing out.

Everything else is a permission. `admin` and `operator` stop being levels and become roles somebody
can read, edit and grant.

## 3. Permissions are patterns over a contract hierarchy

A permission names contracts by pattern:

```
identity.user.find          exactly one
identity.user.*             every action on one collection
build.part.**               everything at or below
**                          everything — see §5
```

**This requires contract names to be a hierarchy, and today they are not.** There are 174 contracts
across 23 flat, one-word domains: `part.find`, `user.create`, `site.seed`. Two segments, and the
first is a collection, not a place.

The hierarchy falls out of the four things in [README.md](./README.md):

```
serve.site.*        serve.release.*      serve.edge.*
build.part.*        build.version.*      build.repository.*      build.artifact.*
identity.user.*     identity.org.*       identity.membership.*   identity.role.*
fleet.node.*        fleet.group.*        fleet.telem.*
```

That is a rename of every contract, which is mechanical and large. It is the price of wildcards
meaning anything, and the naming is better independently of permissions: `build.part.create` says
where a part comes from and `part.create` does not.

## 4. Roles compose

A role is a row holding patterns. Roles inherit, so common sets are named once:

```
build.repository.part.reader   build.part.find, build.part.get
build.repository.part.writer   build.part.create, build.part.update
build.repository.part          inherits both
```

**Inheritance is same-scope only and acyclic**, checked when written and honoured when read. An
organization role cannot inherit a cluster role — that is the rule that keeps an operator from
becoming an owner of every tenant by accident, now that both are the same mechanism.

## 5. The one thing that breaks, and the rule that fixes it

Collapsing levels into permissions removes a protection that was load-bearing.

Today a grant-writing contract is gated by a **level**, never by a permission, for a specific
reason: *a caller who could be granted the right to write grants could grant themselves anything.*
The coarse level existed to break that circle.

If everything is a permission, `identity.grant.create` is grantable and the circle closes.

**The rule that replaces it: you may only grant what you already hold.** A grant is a transfer, not
a creation. Holding `identity.grant.create` lets you give away a subset of your own permissions and
nothing else, so no chain of grants ever produces a permission that was not already in the system.

Three things follow:

- **`**` exists only at the root**, held by the first account at first boot, and is the only place
  authority enters. Everything else is descended from it.
- **Revocation must cascade or be refused.** If A granted B a permission A no longer holds, B's grant
  is no longer descended from anything. Decide which, and say so.
- **The reverse query still has to work.** *Which roles can call this contract* is the question an
  operator actually asks, and with patterns it is a match rather than an index lookup. At 174
  contracts and a few dozen roles that is cheap, and it must stay answerable — it is why a grant is a
  row rather than an array in the first place.

## 6. What `login` answers

> *"when i login with mesh-serve login i should get a complete list of endpoints that my account can
> do. it should not be a list of things my account can do in an org."*

So the answer is **per account, not per organization** — but an account in three organizations has
three different answers, so the list has to carry where each entry applies:

```
identity.user.find                          everywhere
build.part.create        in   Platform
build.part.find          in   Platform, Flowboard Inc
serve.site.seed          in   Platform
```

That is one list, sorted by what the account can do, with the scope as a column rather than as a
separate question. A caller reads it and knows what to try.

**This is a different question from what a site exposes**, and both filters remain:

| | asks | narrows by |
| --- | --- | --- |
| the account's list | *what may I do anywhere* | permissions |
| a site's description | *what does this hostname serve* | the release's declared calls, and the site's grants |

A call succeeds only if both allow it. A site cannot grant a permission the account lacks, and an
account cannot reach a contract the site does not serve. Removing either filter removes a reason
multi-tenancy is safe.

## 7. Scope

The resolved scope is an **organization id**. Never a user id.

It currently reaches a handler under two names, `tenant_id` and `organizationId`, set from the same
value, because a scoped collection is narrowed by *its own* field name and two schemas disagreed:
`site` declares `tenantId`, `membership` declares `organizationId`. **One value, two names, to paper
over a naming disagreement.** Picking one is a migration, not a decision, and it is open.

How it is resolved:

```
ticket ──► account ──► memberships ──► one organization
                            ▲
                   host, or an explicit selection
                   checked against the memberships
```

- **One membership**: that is the scope.
- **Several**: the site's own organization decides, if the caller is a member. A request on
  `flowboard.localhost` means Flowboard Inc, because that is whose site it is.
- **An explicit selection** — a header, a verified path segment — chooses among the caller's
  memberships and is checked against them. It narrows; it cannot add.
- **None that match**: no scope, and every scoped read refuses. A caller outside every organization
  is not a caller with an empty result set.

**The gate returns the scope. A request never supplies one.** This is why the gate returns a value
rather than validating one the request carried.

## 8. What must be true

- **A provisional account can do exactly one thing: set its own password.** Checked in one place so
  no contract can forget. A platform where nothing works until you claim the account is one where it
  gets claimed in the first minute.
- **Changing a password ends other sessions.** A credential that outlives the reason it was changed
  is not a credential that was changed.
- **A ticket is opaque and revocable.** Never a signed claim the server cannot withdraw.
- **A password is never read from argv**, where it is visible in `ps` and lands in shell history.
- **A gate looser than its handler is a promise the platform will not keep.**

## 9. Open, and these block the build

1. **The contract rename** (§3). 174 contracts, flat to hierarchical. Nothing else in this document
   works without it.
2. **Revocation semantics** (§5). Cascade, or refuse to revoke what has been re-granted.
3. **Where `**` lives.** A root role that cannot be edited, or a flag on the first account, or
   something else. It is the one place authority enters the system.
4. **One name for the scope field** (§7).
5. **Field-level visibility.** `user` carries a password hash, a generated find returns the row, and
   no gate subtracts a field — so every `user` action is internal and nothing can turn a user id into
   a name. Six instances deep: the console shows ids, members cannot be named, *who holds this role*
   is unanswerable. The fix is in [collections.md](./collections.md), and §2's operator with
   `identity.user.find` depends on it.
6. **`transferOwnership` exists in the store and no contract calls it.** An operator can create the
   account to hand an organization to and cannot finish the handover, which is the operator's actual
   job.
7. **Changing your own email has no contract**, for the reason in (5).
