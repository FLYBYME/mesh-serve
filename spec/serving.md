# Serving

**One decision, reached over many protocols.**

A connection arrives. Something has to answer four questions before anything else happens:

1. **Which site?** — this address, this hostname, this port.
2. **Which account?** — this credential, or none.
3. **Which organization?** — resolved from the account's memberships.
4. **May this caller call this contract here?** — the site's exposure, then the account's permissions.

A **projection** is a protocol adapter that answers those four in that protocol's own terms and then
gets out of the way. `cdn`, `api` and `mcp` are the first three. `git-http`, `imap`, `smtp` and `ftp`
are coming. **The set is open, and this document is written for that** — a spec that says "three"
will be wrong by the time anyone reads it.

## 1. What a projection is

| projection | caller | carries |
| --- | --- | --- |
| **cdn** | a browser | a page, its kernel, its parts, its import map |
| **api** | an HTTP client, a CLI, a part in a page | routes with schemas |
| **mcp** | an agent | tools with schemas |
| **git-http** | a git client | refs and packfiles |
| **smtp** | a sending mail server | a message for delivery |
| **imap** | a mail client | folders and messages |
| **ftp** | a file client | a directory tree |

**No projection decides what is callable.** Each reads the site's description — the hostname's
release, its exposed contracts, their permissions — and serves what is there. A contract added to a
site appears in every projection that can express it, with nobody editing a table.

> The commands are the contracts.

## 2. What every projection must do

These are the invariants. A projection that cannot satisfy one of them is not ready to be added.

- **Resolve a site before anything else.** A connection that cannot be attributed to a site is
  refused, not served by a default. §4.
- **Resolve an account from the protocol's own credential**, and turn it into the same caller
  everything else uses. §5.
- **Never widen the exposure.** A projection serves a subset of what the site exposes. It may serve
  less — a protocol that cannot express a contract simply does not offer it — and never more.
- **Never resolve its own scope.** The scope comes from the gate, from memberships. A projection
  that computes one has invented a second authorization system.
- **Pass a refusal through whole.** A refusal carries a code and a sentence. Both reach the caller,
  translated into the protocol's own failure shape but never replaced by it. *A status code with the
  reason thrown away is the single most common way this platform has wasted somebody's afternoon.*
- **Say what it cannot express.** If a site exposes something this protocol has no shape for, that is
  a fact about the projection, recorded, not a silent omission.

## 3. What varies, and it is more than it looks

The first three projections are all request/response, JSON-shaped, and carry a `Host` header and a
bearer token. **Nothing about that generalises**, and assuming it did is the mistake this section
exists to prevent.

| | cdn / api / mcp | git-http | smtp | imap / ftp |
| --- | --- | --- | --- | --- |
| shape | request/response | request/response | one-way delivery | stateful session |
| payload | JSON | packfile | a message | streams |
| site from | `Host` header | `Host` header | recipient domain, or SNI | SNI, or login, or port |
| credential | bearer ticket | basic auth, or a token | `AUTH`, or none at all | `LOGIN` |
| caller may be absent | yes, and must work | yes, for a public repo | **yes, and that is normal** | no |

Two of those rows are worth stating as their own problem.

## 4. Which site — the `Host` header is not general

**Multi-tenancy on one process rests on being able to attribute a connection to a site**, and only
the HTTP family carries a hostname in the request. SMTP, IMAP and FTP do not. So resolution is a
chain, and a projection declares which link it uses:

1. **A hostname in the protocol** — `Host`, for the HTTP family.
2. **TLS SNI** — the client names the host during the handshake. This is the general answer for any
   TLS-wrapped protocol, and it is why these protocols should be TLS-only.
3. **An address's domain** — `someone@flowboard.localhost` tells SMTP which site a message is for.
4. **A dedicated port or address** — the fallback. Honest, and it does not scale past a few sites,
   so a projection that can only do this says so.

**A connection that resolves to no site is refused.** There is no default site, because a default
site is one tenant silently receiving another's traffic.

## 5. Which account — every protocol has its own ceremony

`api` takes a bearer ticket. IMAP has `LOGIN`. SMTP has `AUTH`, or nothing. Git has basic auth or a
token in a URL. None of these is the others.

**Each projection turns its protocol's credential into a ticket, and from there everything is the
same.** The ceremony is the adapter's; the caller is identity's. A projection must never carry its
own notion of who somebody is, or there will be as many session models as there are ports.

**SMTP is the one that breaks the shape**, and it is worth saying now rather than discovering it:
inbound mail is *unauthenticated by design*. Anyone may deliver to you. So a projection may have a
site and no account at all, permanently, and the contracts it can reach must be ones that make sense
for an anonymous caller. That is the same requirement as a browser fetching a page, which is
reassuring — it means the rule already exists.

## 6. One description, many renderings

A site has one exposure and one hash. Each projection renders it in its own terms: routes with
schemas, tools with schemas, refs, folders. **A client can tell whether anything changed by
comparing the hash rather than diffing a list.**

Where a contract has no shape in a protocol, it does not appear there, and *which* contracts a
projection can express is part of that projection's own description. So the answer to *"why can an
agent call this and my mail client cannot"* is a fact somebody can look up.

## 7. A site is narrower than a cluster

The node knows every contract it has mounted. A site exposes the subset its release declares it
calls, bounded by its grants. Two sites on one node answer different sets, and neither reaches the
other's by asking.

That is not a convenience. **It is the only reason it is safe to run two tenants in one process**,
and it is the property every new projection has to preserve. A projection that serves from the
node's mounted set rather than the site's exposed set has removed it.

## 8. Open

- **Where bootstrap lives.** A cluster with no sites cannot be reached: resolution is host → site, so
  on a fresh node there is no route to sign in, so no site can be created. The previous answer was
  the node serving one site for itself on `127.0.0.1`, in 414 lines that reached into five other
  domains — which is why serving appeared to depend on everything. It needs a home chosen on
  purpose.
- **Whether a projection is a part.** If protocols are an open set, adding one should not mean
  editing this package. A projection has a shape — resolve, authenticate, express, refuse — and that
  shape is a contract somebody could implement outside.
- **Ports and listeners as records.** Each projection needs an address to listen on, and those are
  facts about a node. That is [fleet.md](./fleet.md)'s territory and the seam is not drawn yet.
- **Whether `_describe` is exempt from the provisional refusal.** A provisional account is refused
  ahead of every check, deliberately — so a site's description is readable with no credential and
  refused with a real provisional one. Defensible, surprising, undecided.
