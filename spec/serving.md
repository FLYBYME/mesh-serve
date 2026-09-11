# Serving

**One surface. Three projections. No third opinion about what is callable.**

A hostname resolves to a release. A release declares what it calls. A caller is answered only if the
site exposes that contract and the caller's standing satisfies its gate. `api`, `cdn` and `mcp` are
three ways of reaching that one decision, for three kinds of caller.

## 1. The projections

| projection | caller | shape |
| --- | --- | --- |
| **cdn** | a browser | a page, its kernel, its parts, its import map |
| **api** | an HTTP client, a CLI, a part in a page | routes with schemas |
| **mcp** | an agent | tools with schemas |

**None of them decides what is callable.** Each reads the site's description — the hostname's
release, its exposed contracts, their gates — and serves what is there. So a contract added to a
site appears as a route, a tool and a client method with nobody editing a table.

> The commands are the contracts.

This was already half-true before these specs: the api and mcp already derive. It is written down
here because the half that did not derive is where every defect came from. A hand-maintained list of
what is callable is a second place to add a contract, and the second place is the one that gets
forgotten.

### The consequence worth stating

**A site is narrower than a cluster.** The node knows every contract it has mounted. A site exposes
the subset its release declares it calls, bounded by what its grants allow. So two sites on one node
answer different sets, and neither can reach what the other exposes by asking nicely.

That is not a convenience. It is the only reason it is safe to run two tenants on one process.

## 2. Everything scopes through identity

Every projection asks identity the same two questions, in this order, and neither is optional:

1. **Who is calling?** A ticket resolves to an account, or there is no caller.
2. **In which organization?** The gate resolves a scope from the caller's **memberships**.

The answer to (2) becomes the meta that confines every scoped collection. A collection declares the
field it is narrowed by, and a find is always within the caller's resolved scope. So *"never expose
an unbounded find"* stops being a discipline and becomes something a contract enforces.

**A scope is never taken from the request.** Not from a header that is trusted, not from a path
segment, not from a body field. The gate returns it and the request may only *claim* one:

- **A hostname implies an organization.** Every request arrives on a host, and that host's site
  belongs to an organization. If the caller is a member of it, that is what they meant.
- **A header selects among the caller's own memberships**, and is checked against them. It narrows;
  it cannot add.
- **A path segment naming an organization is an assertion to verify**, and a mismatch is a refusal.
  It is worth having because a URL that names the organization is one you can paste, log and reason
  about. It is never an input.

Where a route, a query and a body all carry the same field, **the route wins**, because the route
value is the one that was checked. A body that disagrees with a verified route is an error, not a
value to silently discard.

See [identity.md](./identity.md) for what a scope is made of, and [collections.md](./collections.md)
for how a collection declares that it has one.

## 3. Why cdn and api are one thing

They were two folders and one job. `api` calls `cdn`; `cdn` calls everything `api` does and more.
Both answer *"this hostname, this release, this caller, this contract"* — one for a document request
and one for a call. The split produced two places that resolve `Host` → site and two opinions about
what a site is.

`mcp` is the same resolution again for an agent, and it already derives from the same description,
which is the proof the shape works.

## 4. What must be true

- **A contract reachable on a site is reachable in all three projections**, or the reason is written
  down. A tool an agent can call and an HTTP client cannot is a surface that drifted.
- **One description, one hash.** If a site's exposure changes, every projection changes with it and
  a client can tell by comparing a hash rather than by diffing a list.
- **A refusal is an answer, not an error.** It carries a code and a sentence, and every layer passes
  both through. A projection that replaces a refusal with a status code has thrown away the only
  part the caller can act on.
- **Anonymous is a real caller.** A browser fetching a page has no ticket, and the serving path must
  work for it. A collection that cannot be read without a scope cannot be on the serving path.

## 5. Open

- **Bootstrap.** A cluster with no sites cannot be reached, so the node serves one site for itself.
  Today that lives in `cdn/methods/control.ts` and reaches into five other domains, which is what
  makes serving look like it depends on everything. Where it belongs is undecided.
- **Whether `_describe` is exempt from the provisional refusal.** A provisional account is refused
  ahead of every level including `public`, deliberately. So the description of a site is readable
  with no ticket and with a garbage ticket, and refused with a real provisional one — being signed in
  as the account the platform just created for you is the only state where the public endpoint
  refuses. Defensible, surprising, and not yet decided.
