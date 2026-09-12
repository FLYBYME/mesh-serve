# Identity

**Who is calling, and what they may do.** Everything in [serving.md](./serving.md) resolves through
this, and every scoped collection is confined by it.

Identity is the one domain in this repository that calls nothing but itself. That is worth keeping:
it is a dependency of everything and depends on nothing, so it can be reasoned about alone.

**None of this is built.** Where this document says *today*, it is describing `src-dump/`, the deleted
implementation, and the statement is evidence rather than a plan. §2 onward is a redesign: the deleted
model had a coarse `operator` level checked outside the permission system, and this replaces it. The
rename in §4 (**C1**) blocks the rest.

---

## 1. The nouns

| | is | is not |
| --- | --- | --- |
| **account** | a person or a machine that can hold a ticket | a member of anything by itself |
| **organization** | who owns things: sites, repositories, parts | a group of permissions |
| **membership** | an account's place in one organization, carrying roles | the account |
| **role** | a named set of permission patterns, and a row | a level |
| **permission** | a pattern matching contracts — `identity.user.find`, `serve.part.*` | a contract |
| **ticket** | a bearer credential, revocable, with an expiry | a signed claim |
| **api token** | a credential issued to a program, named so it can be revoked alone | a ticket |

### The collections, as they stand

| collection | scope | unique | notes |
| --- | --- | --- | --- |
| `user` | global | `email` | every action internal — see §9 |
| `organization` | global | `slug` | the slug is what a URL or header names |
| `membership` | `organizationId` | `userId`, scoped | one membership per account per org |
| `role` | global | `key` | `builtin` marks the ones seeding installs |
| `grant` | global | `roleKey` + `contract` | `find`, `create`, `delete` exposed; `update` is not |
| `ticket` | global | `token` | every action internal, permanently |
| `apiToken` | global | `tokenHash` | every action internal, permanently |

**`grant.update` is internal on purpose.** A grant is a `(roleKey, contract)` pair and nothing else,
so *changing* one is revoking one and making another — two calls, which is also the record of what
happened. `createMany` stays internal because a bulk grant is the one shape nobody should reach for
casually.

### Fields that matter

```
user            email  displayName  passwordHash?  roles[]  provisional?
                suspendedAt?  suspendedReason?

organization    slug  name  ownerId

membership      userId  organizationId  roleKey  invitedBy?  joinedAt

role            key  name  scope  description?  builtin  inherits[]

grant           roleKey  contract  description?

ticket          token  userId  roles[]  issuedAt  expiresAt  via  revokedAt?  revokedReason?

apiToken        tokenHash  name  userId  organizationId?  roles[]
                createdAt  lastUsedAt?  expiresAt?  revokedAt?
```

**`passwordHash` on `user` is the reason nothing on this platform can turn a user id into a name.**
Every action on `user` is internal because one field must never leave, so the whole collection is
sealed, so an operator holding a list of memberships sees identifiers. That is question **A1**, and it
is the clearest argument in the repository for field-level visibility belonging in `defineCrud`.

---

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
`identity.user.create`, and the `user` role does not. **Nothing about the check is special; only the
grants differ.**

Two coarse states survive, and only because they are about the caller existing rather than about what
they may do:

| | means | used for |
| --- | --- | --- |
| **public** | no caller at all | a browser fetching a page; `ticket_issue`; `sign_out` |
| **authenticated** | some caller, identity matters, permission does not | reading your own account, setting your own password |

Everything else is a permission. `admin` and `operator` stop being levels and become roles somebody
can read, edit and grant.

---

## 3. Permissions are patterns

```
identity.user.find     exactly one contract
identity.user.*        every action on one collection
serve.part.**          everything at or below
**                     everything — see §6
```

### Matching

A permission matches a contract key by segments, split on `.`:

| token | matches |
| --- | --- |
| a literal | that segment exactly, case-sensitively |
| `*` | exactly one segment, any value |
| `**` | one or more segments, and only as the final token |

**`**` is final-only, deliberately.** `serve.**.find` reads as *"find on anything"* and would need
backtracking to evaluate, on the security path, per call. A pattern language that needs a matcher with
a stack is one where nobody can predict what a role grants by reading it.

**No negation.** There is no *"everything except"*, because a permission set built from subtractions
cannot be read off a role — you would have to know the whole contract list to know what the role does,
and the list grows. A narrower positive pattern says the same thing and survives a new contract being
added.

A caller's permissions are the union of every pattern from every role they hold in the relevant place.
**Union, never intersection**: two roles that each grant something grant both.

---

## 4. Two roots

```
identity.user.*       identity.org.*        identity.membership.*
identity.role.*       identity.grant.*      identity.ticket.*

serve.site.*          serve.release.*       serve.edge.*
serve.repository.*    serve.part.*          serve.version.*
serve.node.*          serve.group.*         serve.telem.*
```

Everything a tenant's application declares lives outside both: `flowboard.card.create`,
`flowboard.worktree.dispatch`.

**This requires contract names to be a hierarchy, and today they are not.** 174 contracts across 23
flat, one-word domains — `part.find`, `user.create`, `site.seed`. Two segments, and the first is a
collection, not a place.

| domain | contracts | | domain | contracts |
| --- | --- | --- | --- | --- |
| node | 13 | | user, org, membership, role, grant, ticket, apiToken | 8 each |
| identity | 13 | | site | 9 |
| approval | 11 | | release, part, partVersion, edge, build, artifact, group | 8 each |
| builder | 6 | | cdn | 4 |
| catalog | 3 | | telem | 2 |

### `serve`, not `platform`

**`platform` is taken.** It is an organization slug on every cluster this has run on — the one the
first operator belongs to. A permission root and an organization name that are the same word will be
confused in conversation long before they are confused in code, and a namespace should not need a
disambiguating sentence.

### Uniform depth: `root.noun.action`

The four areas in [README.md](./README.md) are how the code is organised, not a fact about
permissions. Nobody grants *"everything in building"*; they grant everything about parts, or about
repositories.

Adding an area segment would make `serve.build.part.*` and `serve.fleet.node.*` four deep while
`serve.site.*` stays three, **and inconsistent depth makes every wildcard a question about where the
boundary fell.** If a grouping wildcard is genuinely wanted later — `serve.build.**` — it can be added
as a segment then. It cannot easily be removed once roles are written against it.

### The first thing this buys is deleting a list

`ceilingFor` — the rule that stops a seed granting the platform's own contracts to a tenant — is a
hand-maintained set of 23 domain names, and it exists **only** because there was no prefix to test:

```ts
export const PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
    'api', 'apiToken', 'approval', 'artifact', 'build', 'builder', 'catalog', 'cdn', 'edge',
    'grant', 'group', 'identity', 'membership', 'node', 'organization', 'part', 'partVersion',
    'release', 'role', 'site', 'telem', 'ticket', 'user',
]);
```

Add a domain, forget the set, and a tenant can grant themselves a platform contract. A list that must
be kept in step with reality is the shape every spec here exists to remove. With roots it is two
prefixes, **and a new contract is covered by construction.**

### The second thing is why there are two roots and not one

They separate *operating the platform* from *deciding who may operate it*:

```
serve.**        deploy anything, build anything, run anything
identity.**     create accounts, write roles, grant permissions
```

Under a single root those are one permission, so anybody who can operate the cluster can also promote
themselves — which quietly undoes §6, where a grant may only pass on what the granter already holds.
**Two roots make *can do everything* and *can authorise everything* different answers**, and an
operator normally wants the first.

That is a rename of every contract, mechanical and large (**C1**). It is the price of wildcards
meaning anything, and the naming is better independently: `serve.part.create` says whose part it is
and `part.create` does not.

---

## 5. Roles compose

A role is a row holding patterns. Roles inherit, so common sets are named once:

```
serve.part.reader     serve.part.find, serve.part.get, serve.part.count
serve.part.writer     serve.part.create, serve.part.update
serve.part.admin      inherits both, plus serve.part.delete
```

**Inheritance is same-scope only and acyclic**, checked when written and honoured when read. A role
has a `scope` — the whole deployment, or one organization — and an organization role cannot inherit a
cluster role. That is the rule that keeps an operator from becoming an owner of every tenant by
accident, now that both are the same mechanism.

A cycle is refused at write time rather than guarded at read time, because resolution runs on the
security path once per call and must terminate without a visited-set.

---

## 6. Why the last level can go too

Today a grant-writing contract is gated by a **level**, never by a permission, for a specific reason:
*a caller who could be granted the right to write grants could grant themselves anything.* The coarse
level existed to break that circle.

So `identity.grant.create` looks like the one permission that cannot safely be a permission. It is not
— **the level was only ever needed because a grant could create authority out of nothing.**

**A grant is a transfer, not a creation. You may only grant what you already hold.**

With that, a caller holding `identity.grant.create` can give away a subset of their own permissions
and nothing else, so no chain of grants ever produces a permission that was not already in the system.
The circle cannot close, and the level has nothing left to protect. It becomes an ordinary role —
`identity.grant.writer`, held by whoever hands out access — and **there is no special case left
anywhere in the model.**

Checking it is a subset test in the pattern language of §3: every pattern being granted must be
matched by, or equal to, a pattern the granter holds. `serve.part.*` may grant `serve.part.find`. It
may not grant `serve.part.**` if that would reach further, and it may not grant `serve.*`.

Three things follow:

- **`**` exists only at the root**, held by the first account at first boot, and is the only place
  authority enters the system. Everything else descends from it. Where that lives is **C3**.
- **Revocation must cascade or be refused.** If A granted B a permission A no longer holds, B's grant
  descends from nothing. Decide which, and say so — **C2**. Either is defensible; silence is not.
- **The reverse query must stay answerable.** *Which roles can call this contract* is the question an
  operator actually asks, and with patterns it is a match rather than an index lookup. At 174
  contracts and a few dozen roles that is cheap. It is also why a grant is a row rather than an array
  on the role.

---

## 7. What `login` answers

> *"when i login with mesh-serve login i should get a complete list of endpoints that my account can
> do. it should not be a list of things my account can do in an org."*

**Per account, not per organization** — but an account in three organizations has three different
answers, so the list carries where each entry applies:

```
identity.user.find                          everywhere
serve.part.create        in   Platform
serve.part.find          in   Platform, Flowboard Inc
serve.site.seed          in   Platform
```

One list, sorted by what the account can do, with scope as a column rather than as a separate
question. A caller reads it and knows what to try.

**This is a different question from what a site exposes**, and both filters remain:

| | asks | narrows by |
| --- | --- | --- |
| the account's list | *what may I do anywhere* | permissions |
| a site's description | *what does this hostname serve* | the release's declared calls, and the site's grants |

**A call succeeds only if both allow it.** A site cannot grant a permission the account lacks, and an
account cannot reach a contract the site does not serve. Removing either filter removes a reason
multi-tenancy is safe.

---

## 8. Scope

The resolved scope is an **organization id**. Never a user id.

```
ticket ──► account ──► memberships ──► one organization
                            ▲
                   host, or an explicit selection
                   checked against the memberships
```

### The algorithm, exactly

| | memberships | requested | site's org | result |
| --- | --- | --- | --- | --- |
| 1 | any | named, and a member | any | **that one** |
| 2 | any | named, not a member | any | **404 `no_such_organization`** |
| 3 | exactly one | none | any | **that one** |
| 4 | several | none | one the caller is in | **the site's** |
| 5 | several | none | not one of theirs, or none | **no scope** |
| 6 | none | none | any | **no scope** |

**Case 2 is a 404 and not a 403.** Whether an organization exists is not something an unrelated caller
gets to confirm by probing.

**Case 4 is what a hostname is for.** A request on `flowboard.localhost` means Flowboard Inc, because
that is whose site it is. The site *chooses among* the caller's memberships and cannot add to them, so
this widens nothing. It was added because the operator becomes a member of every tenant the moment
they seed one — seeding makes the caller the owner — and from then on every scoped read answered

```
401  Scoped collection "site" requires a resolved "tenantId" scope
```

which a browser's transport renders as *"You need to sign in"*, to somebody who was signed in.

**Cases 5 and 6 produce no scope, and a scoped read then refuses.** Guessing which organization was
meant is how a request reads the wrong tenant's data. The refusal is `ORGANIZATION_REQUIRED`, 400, and
it names **both** causes because the gate cannot tell them apart without another lookup: an account in
no organization, and one in several that did not say.

**The gate returns the scope. A request never supplies one.** This is why the gate returns a value
rather than validating one the request carried.

### One value, two names

It reaches a handler as both `tenant_id` and `organizationId`, set from the same value, because a
scoped collection is narrowed by *its own* field name and two schemas disagreed: `site` declares
`tenantId`, `membership` declares `organizationId`. **One value under two names to paper over a naming
disagreement.** Picking one is a migration, not a decision — **B2**, and it gets harder per collection
written.

---

## 9. Tickets, tokens and revocation

A ticket is **opaque and revocable**: a row, not a signed claim the server cannot withdraw. That is
the whole reason it is a row.

```
issue ──► ticket { token, userId, roles, issuedAt, expiresAt, via }
   │
   ├── sign_out      ends this one. Always answers signedOut: true.
   ├── ticket_revoke ends one token, or every ticket a named userId holds.
   └── expiry        passive.
```

**`sign_out` deliberately does not report whether anything was revoked.** Signing out with no ticket,
an expired one, or one already revoked all answer the same, because the difference is information
about a credential the caller does not hold.

**Revocation is correct rather than likely, because of an epoch.** The mesh delivers events
at-most-once, so an API instance that was down when a ticket was revoked never hears about it.
`identity.revocations_since(epoch)` cannot be missed, only delayed — every instance polls, and a
revocation has a monotonic epoch it can ask from. An event is the fast path; the poll is the correct
one.

### What must be true

- **A provisional account can do exactly one thing: set its own password.** Checked in one place so no
  contract can forget. A platform where nothing works until you claim the account is one where it gets
  claimed in the first minute.
- **`set_password` takes no `userId`.** The caller *is* the subject. A contract that took an id would
  be one missing check away from being a different, far more dangerous act.
- **A password is at least twelve characters**, and is **never read from argv**, where it is visible in
  `ps` and lands in shell history. [cli.md](./cli.md) §4.
- **Changing a password ends other sessions.** A credential that outlives the reason it was changed is
  not a credential that was changed.
- **An API token is named**, so revoking the right one is possible, and carries `agent` into the
  caller so a program is never mistaken for a person.
- **A gate looser than its handler is a promise the platform will not keep.**

---

## 10. Open

The rename (**C1**) blocks everything from §4 onward. Revocation semantics (**C2**), the root wildcard
(**C3**), field-level visibility (**A1**), the scope field's name (**B2**), `transferOwnership` with no
contract (**E1**) and changing your own email (**E2**) are in [questions.md](./questions.md).
