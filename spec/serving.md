# Serving

**One decision, reached over many protocols.**

A connection arrives. Something has to answer four questions before anything else happens:

| | question | answered from | refusal if it cannot |
| --- | --- | --- | --- |
| 1 | **which site?** | this address, this hostname, this port | `NO_SITE` |
| 2 | **which account?** | this credential, or none | `UNAUTHENTICATED` |
| 3 | **which organization?** | the account's memberships, narrowed by the site | `NO_SCOPE` |
| 4 | **may this caller call this here?** | the site's exposure, then the account's permissions | `FORBIDDEN` |

A **projection** is a protocol adapter that answers those four in that protocol's own terms and then
gets out of the way. `cdn`, `api` and `mcp` are the first three. `git-http`, `smtp`, `imap` and `ftp`
are coming. **The set is open, and this document is written for that** — a spec that says "three"
will be wrong by the time anyone reads it.

---

## 1. The projections

**None of these exists.** Three of them did and were deleted with `src/`; the rest were never
written. The column below says which, because the two are different kinds of unknown: one has been
run against a browser and an agent, the other has not been run at all.

| projection | caller | carries | prior art |
| --- | --- | --- | --- |
| **cdn** | a browser | a page, its kernel, its parts, its import map | 4,600 lines, deleted |
| **api** | an HTTP client, a CLI, a part in a page | routes with schemas | 6,232 lines, deleted |
| **mcp** | an agent | tools with schemas | in the api tree, deleted |
| **git-http** | a git client | refs and packfiles | none |
| **smtp-submission** | a phone, a mail client | a message to send, authenticated | none |
| **smtp-relay** | another mail server | a message to deliver, anonymous | none |
| **imap** | a mail client | folders and messages | none |
| **ftp** | a file client | a directory tree | none |

**No projection decides what is callable.** Each reads the site's description — the hostname's
release, its exposed contracts, their gates — and serves what it can express. A contract added to a
site appears in every projection that can express it, with nobody editing a table.

> The commands are the contracts.

---

## 2. The pipeline

Every projection runs the same stages in the same order. The order is not arbitrary: each stage
either produces something the next one needs, or refuses in a way that must not leak what a later
stage would have found.

```
   connection
       │
  1 ── resolve site ─────────────► NO_SITE                    §3
       │                            (never a default site)
  2 ── find the route ───────────► NO_ROUTE, METHOD_NOT_ALLOWED
       │
  3 ── reject internal ──────────► INTERNAL_CONTRACT          §5
       │                            (before reading the body)
  4 ── resolve caller ───────────► (no refusal — absence is a valid answer)  §4
       │
  5 ── coarse gate ──────────────► PROVISIONAL_ACCOUNT, UNAUTHENTICATED, FORBIDDEN  §6
       │
  6 ── authorize hook ───────────► FORBIDDEN                  §6
       │   (may only narrow)
  7 ── resolve scope ────────────► NO_SCOPE, ORGANIZATION_REQUIRED  identity.md §8
       │
  8 ── parse input ──────────────► INVALID_JSON, INVALID_INPUT, BODY_TOO_LARGE
       │
  9 ── ctx.call ─────────────────► the contract's own failures       errors.md
       │
 10 ── parse output ─────────────► (a handler that returns the wrong shape is a 500)
       │
   response
```

**Two orderings are load-bearing.**

**Stage 3 before stage 8.** An internal contract is refused before its body is read, so an unexposed
contract cannot be probed by watching which inputs parse.

**Stage 5 before stage 6.** The coarse gate always runs, and the hook runs after it and **can only
narrow**. The previous implementation had this the other way round:

```ts
if (authorize) { /* delegate entirely */ } else { checkAuth(entry.auth) }
```

so supplying a hook **replaced** the gate. surfdns found it and wrote it down before anyone here did:
*"a hook that returns 'no objection from me' grants everything."* **A security boundary that can be
switched off by returning `true` from the wrong place is not a boundary.**

---

## 3. Which site — the `Host` header is not general

**Multi-tenancy on one process rests on being able to attribute a connection to a site**, and only
the HTTP family carries a hostname in the request. SMTP, IMAP and FTP do not.

So resolution is a **chain**, and a projection declares which link it uses:

| | link | used by | scales to |
| --- | --- | --- | --- |
| 1 | a hostname in the protocol — `Host` | cdn, api, mcp, git-http | every site |
| 2 | **TLS SNI** — the client names the host in the handshake | any TLS-wrapped protocol | every site |
| 3 | an address's domain — `someone@flowboard.localhost` | smtp-relay | every site |
| 4 | a dedicated port or address | the fallback | a handful |

**TLS SNI is the general answer**, and it is why these protocols should be TLS-only. A projection
that can only do (4) says so in its own description, because *"this protocol supports one site per
node"* is a fact somebody planning a cluster needs.

### Normalisation

A hostname is lowercased, its port stripped, its trailing dot removed. `Example.com`,
`example.com:443` and `example.com.` are **one site**. Without this a site is findable under one
spelling and missing under another, which is a 404 that comes and goes with how a link was typed.

`localhost` and `127.0.0.1` stay distinct, deliberately — it is what lets one node serve two sites
during development, and it is how the control site is addressed.

### Forwarded headers

`x-forwarded-host` may carry a list when a request crossed more than one proxy. **The first entry is
the client's original host**; the rest are intermediaries. Anything else serves the site belonging to
a proxy.

**Trust is a deployment decision, never a guess.** Behind a trusted proxy the header is
authoritative, because the proxy rewrote `Host` to reach this node. A node reachable directly must
not trust it: a caller could then name any hostname and be served whatever it serves. The content is
public either way, so this is not a disclosure — but it makes the **origin** a caller's choice, and
the origin is what a browser isolates storage and cookies by.

### No default

**A connection that resolves to no site is refused with `NO_SITE`.** There is no default site,
because a default site is one tenant silently receiving another's traffic. This has no exceptions and
is the single invariant most likely to be eroded by a convenience.

---

## 4. Which account — every protocol has its own ceremony

| projection | credential | absent means |
| --- | --- | --- |
| api, mcp | `Authorization: Bearer <ticket>`, or an API token | anonymous, and valid |
| cdn | none — a page fetch is anonymous | the normal case |
| git-http | basic auth, or a token in the URL | anonymous, valid for a public repo |
| smtp-submission | `AUTH` over TLS | **refused** |
| smtp-relay | none, ever | **the only case** |
| imap, ftp | `LOGIN` | refused |

**Each projection turns its protocol's credential into a ticket, and from there everything is the
same.** The ceremony belongs to the adapter; the caller belongs to identity. A projection must never
carry its own notion of who somebody is, or there will be as many session models as there are ports.

A resolved caller is exactly this, and nothing else:

```ts
interface Caller {
    readonly userId: string;
    readonly roles: readonly string[];
    readonly provisional?: boolean;   // created by the platform, not yet claimed
    readonly agent?: string;          // the API token's name, when it arrived on one
}
```

**`agent` is why a token is not a person.** A token is issued *to a program*. Two accounts that
resolve to the same `userId` are still different callers, because a destructive contract asks a
person to confirm and there is nobody to ask on a token, because an audit line saying *"tim deleted
the release"* when tim's agent did is a lie that reads as fact, and because a token is revocable on
its own. **Its absence means a person**, which is the safe direction: a new credential kind that
forgot to set it is treated as more suspicious rather than less.

### SMTP is two projections wearing one name

Treating it as one is how a relay ends up open.

| | port | caller | what it is |
| --- | --- | --- | --- |
| **submission** | 587 | **authenticated, always** | a phone or a mail client sending *as* somebody |
| **relay** | 25 | **anonymous, by design** | another mail server delivering *to* somebody |

A phone sending mail authenticates — `AUTH` over TLS, an account and a password — and everything in
this document applies to it unchanged: an account, a scope, permissions.

Inbound relay is the opposite and cannot be otherwise: anyone on the internet may deliver to you, and
a server demanding credentials would receive no mail. That projection has a site and **permanently no
account**, and the contracts it can reach must be ones that make sense for an anonymous caller.

**The two must never share a listener.** They resolve their site differently too — submission by SNI,
relay by the recipient's domain — which is the clearest case in this document for §3 being a chain
rather than a rule.

The reassuring part: **anonymous-with-a-site is not a new requirement.** A browser fetching a page is
already exactly that.

---

## 5. What a site exposes

A site's exposure is a list of entries. Each names one contract and exactly one gate.

```ts
type ExposeEntry =
    | { contract: ToolContract; auth: 'public' | 'user' | 'admin' | 'operator'; errors?: string[] }
    | { contract: ToolContract; permission: string;                            errors?: string[] };
```

**The union is the enforcement.** An entry with neither `auth` nor `permission` satisfies neither
member and does not compile. *"An omitted gate must never quietly mean open"* is a type error rather
than a review someone might skip. `gateOf` re-checks at runtime and throws, for a descriptor loaded
from JSON or built elsewhere — the same two-layer approach the kernel takes with capabilities.

The `auth` levels are on their way out. [identity.md](./identity.md) §2 replaces them with
permissions, keeping only `public` and `authenticated`, and `permission` is the entry kind that
survives. Until the rename (**C1**) both exist.

**`errors` is part of the public surface.** It is declared here rather than derived from the handler,
so which failures a caller must handle does not change silently when a handler is edited. It reaches
the generated client as a literal union.

### Internal is the default, and it is checked twice

A contract carries its own `visibility`, defaulting to `internal`. A site may not expose an internal
contract: `describeExposure` refuses the entry, with `EXPOSURE_MISMATCH`.

**This check has caught real mistakes twice**, and both are worth keeping:

- `identity.ticket_issue` was internal. Signing in is the one call that cannot require being signed
  in, so the contract was wrong and the check was right.
- mesh-auth declared `identity.ticket_revoke` among the contracts it calls, and was refused. That
  contract takes a `userId`, so it ends every ticket a *named person* holds — an operator suspending
  an account, not a browser's sign-out. The extension had been posting to that path since it was
  written. `identity.sign_out` exists because of it, taking the token the caller already holds:
  **presenting a token proves you hold it, and revoking a ticket you hold is strictly less powerful
  than using it.**

---

## 6. The gate

```
       ┌─ provisional? ──────────► only identity.set_password    PROVISIONAL_ACCOUNT
       │
 gate ─┼─ coarse level or permission ──► UNAUTHENTICATED | FORBIDDEN
       │
       └─ authorize hook ─────────► may deny, may resolve a scope. May not admit.
```

**A provisional account is refused ahead of everything.** It is the account the platform creates on
first boot, and the one thing it may do is set its own password, which clears the flag. Named in one
place rather than kept as a list of exceptions, because a list is a thing that grows.

Without that carve-out the first boot produces **a locked room with no door**: the wall was built and
the way out was not, so the credential printed at boot could do nothing at all, including stop being
provisional. Found by the first person to run it. Whether `_describe` should also be exempt is
**E3**.

---

## 7. What every projection must do

Conformance. A projection that cannot satisfy one of these is not ready to be added.

1. **Resolve a site before anything else.** A connection that cannot be attributed to a site is
   refused, never served by a default. §3.
2. **Resolve an account from the protocol's own credential**, and turn it into the `Caller` above.
   §4.
3. **Never widen the exposure.** A projection serves a subset of what the site exposes. It may serve
   less — a protocol with no shape for a contract simply does not offer it — and never more.
4. **Never resolve its own scope.** The scope comes from the gate, from memberships. A projection
   that computes one has invented a second authorization system.
5. **Serve from the site's exposed set, never the node's mounted set.** §9.
6. **Pass a refusal through whole.** Code and sentence both reach the caller, translated into the
   protocol's failure shape and never replaced by it. [errors.md](./errors.md).
7. **Say what it cannot express.** A contract a protocol has no shape for is a recorded fact about
   the projection, not a silent omission. §8.
8. **Declare its own timeouts.** The broker's default is ten seconds, which is right for a question
   and wrong for work. [building.md](./building.md) §6.

---

## 8. One description, many renderings

A site has one exposure and one `shapeHash`. Each projection renders it in its own terms:

| projection | renders the exposure as |
| --- | --- |
| api | routes: method, path, input schema, output schema, declared errors |
| mcp | tools: name, description, JSON Schema in and out |
| cdn | an import map, a kernel, a part list, and the descriptor the page fetches |
| git-http | refs and packfiles for the repositories the site exposes |
| imap | folders, where a collection has a folder shape and most do not |

**A client tells whether anything changed by comparing the hash rather than diffing a list.**

Where a contract has no shape in a protocol it does not appear there, and *which* contracts a
projection can express is part of that projection's own description. So *"why can an agent call this
and my mail client cannot"* is a question somebody can look up rather than infer.

The descriptor a site publishes carries, per call: the key, domain, action, description, method,
path, gate, input schema, output schema, `destructive`, `stream`, and declared errors. **`destructive`
is what makes a UI ask before doing**, and it is the contract's own declaration rather than a guess
from the verb.

---

## 9. A site is narrower than a cluster

The node knows every contract it has mounted. A site exposes the subset its release declares it
calls, bounded by its grants. Two sites on one node answer different sets, and neither reaches the
other's by asking.

**This is the only reason it is safe to run two tenants in one process**, and it is the property every
new projection has to preserve. A projection that serves from the node's mounted set rather than the
site's exposed set has removed it — and that is a mistake with no symptom until the wrong tenant
calls something.

The check has a name: a call reaching a contract the site does not list is `EXPOSURE_MISMATCH`, not
`NO_ROUTE`. The difference matters because one is a client error and the other is a configuration
error, and telling somebody *"no such route"* when the route exists on a different site has cost
afternoons.

---

## 10. Open

Bootstrap (**D1**), whether a projection is a part (**D2**), and listeners as records (**D5**) are in
[questions.md](./questions.md). **D2** is the one that decides how large this package is: if a
projection is a part, adding a protocol is a release rather than an edit to this repository.
