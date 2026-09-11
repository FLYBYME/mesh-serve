# mesh-serve

**Status: being defined, 2026-09-11.** The previous specs are in git and in `spec copy/`. They
described what had been built. These describe what it is for, which is the thing that was never
written down — and the cost of not writing it is measurable: 24,332 lines in six days across nine
things that were never decided to be nine things.

## What it is

**A hostname resolves to a release, and a call is answered only if that site exposes it.**

That is the whole of it. Everything else in this repository is either how a release comes to exist,
how a machine comes to run one, or who the caller is.

## What it is not

It is not mesh. mesh is the framework underneath — the broker, the contracts, the typed tool
registry, the database layer. It is three and a half months old, 19,930 lines, and **frozen**
(`mesh/docs/STABILITY.md`). Everything mesh-serve needs about calling a contract, typing a result or
scoping a collection is already there and already typed. Reaching around it is the single most
common defect in this repository's history and it has its own record in `stuff.md`.

## The four things

Not nine. The nine were domain folders, which is a filing decision, not a design one.

| | what it answers | made of |
| --- | --- | --- |
| **[serving](./serving.md)** | a hostname resolves to a release, and who may call what | api, cdn, mcp |
| **[building](./building.md)** | how a release comes to exist | catalog, builder |
| **[identity](./identity.md)** | who is calling, and in which organization | identity |
| **[fleet](./fleet.md)** | which machines run what | fleet, supervisor, telemetry |

Two facts about that table matter more than the table.

**Serving is one surface with three projections, not three services.** `api`, `cdn` and `mcp` answer
the same question to a browser, an HTTP client and an agent. They do not each decide what is
callable; they read one description and serve what is there. See [serving.md](./serving.md), which is
the spec to read first.

**Fleet is independent.** It answers *which machines run what*, and nothing in serving or building
needs to know. Telemetry belongs inside it: metrics are about machines, and the only reason
`telem` was a separate domain is that it was written separately. The dependency graph already says
so — `telem` calls nothing but itself and one wrong-direction call into `cdn`, which is the edge to
delete.

## What has no home yet

**Bootstrap.** A cluster with no sites cannot be reached: the api dispatches by `Host` → site, so on
a fresh node there is no route to `identity.ticket_issue`, so nobody can sign in, so no site can be
created. The current answer is the node serving one site for itself on `127.0.0.1`, and it lives in
`cdn/methods/control.ts` — 414 lines reaching into identity, catalog, builder, fleet and telemetry.

That file is why `cdn` appears to depend on seventeen domains. It is not the CDN having
dependencies; it is orchestration filed under a domain name because it needed somewhere to live.
Deciding where bootstrap belongs is the open question, and it is open on purpose rather than by
neglect.

## Reading order

1. [serving.md](./serving.md) — the one surface and its three projections. Everything else refers to it.
2. [identity.md](./identity.md) — who is calling, and what a scope is.
3. [collections.md](./collections.md) — how a collection is defined, and why not with `defineCrud` alone.
4. [building.md](./building.md) — repositories, parts, releases.
5. [fleet.md](./fleet.md) — nodes, supervision, telemetry.

## Rules that apply everywhere

These are not style. Each one is here because breaking it cost a day or more, and the evidence is in
`stuff.md`.

- **Everything this package provides is reachable through its API and its CLI, and through nothing
  else.** No script that opens the database. No process that joins the mesh to assert an identity.
  A browser and a terminal make the same call.
- **Use the typing that exists.** `ctx.call` is generic over the tool registry. `ctx.meta` is
  `IMeshMeta`. `broker.getProvider` is typed. A cast in front of any of them is a bug.
- **A scope is resolved, never supplied.** The gate returns it, from the caller's memberships. A
  request that carries one is making a claim to be checked, not stating a fact to be used.
- **Absent means internal.** A contract is not reachable because it exists. Publishing one is a
  decision somebody writes down.
- **Name the reader, or do not add the field.** A field nothing reads is a promise nothing keeps,
  and this repository has produced that shape more than any other.
