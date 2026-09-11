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
| **permission** | a pattern matching contracts — `identity.user.find`, `serve.part.*` | a contract |
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
serve.part.**              everything at or below
**                          everything — see §5
```

**This requires contract names to be a hierarchy, and today they are not.** There are 174 contracts
across 23 flat, one-word domains: `part.find`, `user.create`, `site.seed`. Two segments, and the
first is a collection, not a place.

### Two roots

```
identity.user.*       identity.org.*        identity.membership.*
identity.role.*       identity.grant.*      identity.ticket.*

serve.site.*          serve.release.*       serve.edge.*
serve.repository.*    serve.part.*          serve.version.*
serve.node.*          serve.group.*         serve.telem.*
```

Everything a tenant's application declares lives outside both: `flowboard.card.create`,
`flowboard.worktree.dispatch`.

**`serve`, not `platform`, because `platform` is taken.** It is an organization slug on every
cluster this has run on — the one the first operator belongs to. A permission root and an
organization name that are the same word will be confused in conversation before they are confused
in code, and a namespace should not need a disambiguating sentence.

**Uniform depth: `root.noun.action`.** The four areas in [README.md](./README.md) are how the code is
organised, not a fact about permissions — nobody grants *"everything in building"*, they grant
everything about parts, or about repositories. Adding an area segment would make `serve.build.part.*`
and `serve.fleet.node.*` four deep while `serve.site.*` stays three, and inconsistent depth makes
every wildcard a question about where the boundary fell.

If a grouping wildcard is genuinely wanted later — `serve.build.**` — it can be added as a segment
then. It cannot easily be removed once roles are written against it.

**The first thing this buys is deleting a list.** `ceilingFor` — the rule that stops a seed granting
the platform's own contracts to a tenant — is currently a hand-maintained set of 23 domain names,
and it exists *only* because there was no prefix to test:

```ts
export const PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
    'api', 'apiToken', 'approval', 'artifact', 'build', 'builder', 'catalog', 'cdn', 'edge',
    'grant', 'group', 'identity', 'membership', 'node', 'organization', 'part', 'partVersion',
    'release', 'role', 'site', 'telem', 'ticket', 'user',
]);
```

Add a domain, forget the set, and a tenant can grant themselves a platform contract. A list that
must be kept in step with reality is the shape every spec here exists to remove. With roots it is
two prefixes, and a new contract is covered by construction.

**The second thing is the reason there are two roots and not one.** They separate *operating the
platform* from *deciding who may operate it*:

```
serve.**        deploy anything, build anything, run anything
identity.**     create accounts, write roles, grant permissions
```

Under a single root those are the same permission, so anybody who can operate the cluster can also
promote themselves — which quietly undoes §5, where a grant may only pass on what the granter
already holds. Two roots make *"can do everything"* and *"can authorise everything"* different
answers, and an operator normally wants the first.

That is a rename of every contract, mechanical and large. It is the price of wildcards meaning
anything, and the naming is better independently of permissions: `serve.part.create` says whose
part it is and `part.create` does not.

## 4. Roles compose

A role is a row holding patterns. Roles inherit, so common sets are named once:

```
serve.part.reader     serve.part.find, serve.part.get
serve.part.writer     serve.part.create, serve.part.update
serve.part.admin      inherits both, plus serve.part.delete
```

**Inheritance is same-scope only and acyclic**, checked when written and honoured when read. An
organization role cannot inherit a cluster role — that is the rule that keeps an operator from
becoming an owner of every tenant by accident, now that both are the same mechanism.

## 5. Why the last level can go too

Today a grant-writing contract is gated by a **level**, never by a permission, for a specific
reason: *a caller who could be granted the right to write grants could grant themselves anything.*
The coarse level existed to break that circle.

So `identity.grant.create` looks like the one permission that cannot safely be a permission. It is
not — **the level was only ever needed because a grant could create authority out of nothing.**

**A grant is a transfer, not a creation. You may only grant what you already hold.** With that, a
caller holding `identity.grant.create` can give away a subset of their own permissions and nothing
else, so no chain of grants ever produces a permission that was not already in the system. The
circle cannot close, and the level has nothing left to protect.

Which means it is an ordinary role like any other — `identity.grant.writer`, held by whoever should
be handing out access — and there is no special case left anywhere in the model.

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
serve.part.create        in   Platform
serve.part.find          in   Platform, Flowboard Inc
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

## 9. Open

The contract rename (**C1**) blocks everything in §3 onward. Revocation (**C2**), the root
wildcard (**C3**) and field-level visibility (**A1**) are in [questions.md](./questions.md).
