# mesh-serve

**Status: the first slice runs, 2026-09-11.** A node boots, identity mints the first account, one
site answers on `127.0.0.1`, and `mesh-serve login` works from a terminal and prints what it did.
38 tests. Everything else in these documents is still specification.

The rest of `src/` was deleted; the previous implementation is in `src-dump/` and is referenced
throughout as evidence rather than as a design. Where a number, a schema or an error code appears
here, it was read out of that tree.

**Three things in these specs were wrong and building found them.** They are corrected in place and
recorded in [questions.md](./questions.md): `scopedBy` cannot be used on the collections that
*produce* a scope (**B2**), a CRUD hook only runs on the module whose domain matches the collection,
and a public contract must stay public for an unclaimed account (**E3**).

## What it is

**A hostname resolves to a release, and a call is answered only if that site exposes it.**

That is the whole of it. Everything else in this repository is either how a release comes to exist,
how a machine comes to run one, or who the caller is.

## What it is not

It is not mesh. mesh is the framework underneath: the broker, the contracts, the typed tool registry,
the database layer. 107 days old, 19,930 lines, 186 lines per day. mesh-serve was 24,332 lines in six
days — 4,055 lines per day — and the difference between those two rates is the entire subject of
`stuff.md`.

Everything mesh-serve needs about calling a contract, typing a result or scoping a collection is
already in mesh and already typed. Reaching around it is the most common defect in this repository's
history: 176 casts in mesh-serve, against 30 in mesh-core and 7 in mesh-operator.

**mesh is stable, not sealed, and the difference decides where work goes.**

| | says | means |
| --- | --- | --- |
| `mesh/docs/STABILITY.md` | bug fixes only | mesh must not drift under three packages built on it at once |
| `surfdns/architecture/the-freeze.md` | mesh 2 → 3 is planned | *"the version bump is the last cheap breaking change"* |

Its Track V is three `defineCrud` items, all breaking, and field-level visibility is called there
*"the single strongest argument for v3 being a real major rather than a renumbering"*.

So the rule is: **do not drift mesh, and do not route around it either.** Anything that belongs in
`defineCrud` goes into the 2 → 3 bump, because after that it is permanent. See
[collections.md](./collections.md) §3.

## The four things

Not nine. The nine were domain folders, which is a filing decision, not a design one.

| | what it answers | absorbed | contracts today |
| --- | --- | --- | --- |
| **[serving](./serving.md)** | a connection resolves to a site, and who may call what | cdn, api, mcp | 14 |
| **[identity](./identity.md)** | who is calling, and in which organization | identity | 61 |
| **[building](./building.md)** | how a release comes to exist | catalog, builder | 49 |
| **[fleet](./fleet.md)** | which machines run what | fleet, supervisor, telem | 23 |

Plus `approval` (11), which is self-contained and may not belong here at all — question **D4**.

Two facts about that table matter more than the table.

**Serving is one decision reached over many protocols, not a service per protocol.** `cdn`, `api` and
`mcp` answer the same four questions for a browser, an HTTP client and an agent; `git-http`, `smtp`,
`imap` and `ftp` will answer them for their own callers. **The set is open.** None of them decides
what is callable — each reads one description and serves what it can express.

**Fleet is independent.** Nothing in serving or building needs to know how many nodes there are.
Telemetry belongs inside it: metrics are about machines, and the only reason `telem` was a separate
domain is that it was written separately. The dependency graph already says so — `telem` calls
nothing but itself and one call into `cdn`, the single wrong-direction edge in the whole graph.

## What has no home yet

**Bootstrap.** A cluster with no sites cannot be reached. Resolution is connection → site, so on a
fresh node there is no route to `identity.ticket_issue`, so nobody can sign in, so no site can be
created. The previous answer was the node serving one site for itself on `127.0.0.1`, and it lived in
`cdn/methods/control.ts`: **414 lines reaching into 33 foreign contracts across identity, catalog,
builder, fleet and telemetry.**

That file is the entire reason `cdn` appeared to depend on everything. It is not the CDN having
dependencies; it is orchestration filed under a domain name because it needed somewhere to live.
Question **D1**, and it is open on purpose rather than by neglect.

## Reading order

| | | read it for |
| --- | --- | --- |
| 1 | [serving.md](./serving.md) | the four questions, and the protocols that answer them |
| 2 | [identity.md](./identity.md) | accounts, permissions, scope, tickets |
| 3 | [collections.md](./collections.md) | how a collection is declared, and what `defineCrud` still lacks |
| 4 | [errors.md](./errors.md) | the wire contract for a refusal — read before writing a projection |
| 5 | [building.md](./building.md) | repositories, parts, versions, releases, artifacts |
| 6 | [fleet.md](./fleet.md) | nodes, supervision, telemetry |
| 7 | [cli.md](./cli.md) | the terminal surface, which is the same API |
| 8 | [questions.md](./questions.md) | every open decision, grouped by deadline |

## Rules that apply everywhere

Not style. Each is here because breaking it cost a day or more, and the evidence is in `stuff.md`.

1. **Everything this package provides is reachable through its API and its CLI, and nothing else.**
   No script that opens the database. No process that joins the mesh to assert an identity. A browser
   and a terminal make the same call.
2. **Use the typing that exists.** `ctx.call` is generic over `IServiceToolRegistry`. `ctx.meta` is
   `IMeshMeta`, which its own comment says domain services should augment. `broker.getProvider<T>` is
   typed and `onStart(broker)` hands it to you. **A cast in front of any of them is a bug**, not a
   style preference — see [collections.md](./collections.md) §6.
3. **A scope is resolved, never supplied.** The gate returns it from the caller's memberships. A
   request that carries one is making a claim to be checked, not stating a fact to be used.
4. **Absent means internal.** A contract is not reachable because it exists. Publishing one is a
   decision somebody writes down.
5. **Name the reader, or do not add the field.** A field nothing reads is a promise nothing keeps,
   and this repository has produced that shape more than any other — `relations` and `populate` are
   declared in `defineCrud` and consumed nowhere.
6. **A prefix, not a list.** Two roots, `identity.*` and `serve.*`, with a tenant's own contracts
   outside both. Every rule about *this platform's own* becomes a prefix test, and the 23-name
   `PLATFORM_DOMAINS` set kept in step by hand goes away. Not `platform.*` — that word is an
   organization slug on every cluster this has run on. [identity.md](./identity.md) §4.
7. **A gate looser than its handler is a promise the platform will not keep.**
8. **A refusal carries a code and a sentence, and both reach the caller.** [errors.md](./errors.md).

## How to read these documents

- **must / must not** is a conformance requirement. A build that violates one is wrong, not
  stylistically unusual.
- **A bold claim followed by a paragraph** is an argued decision. The paragraph is the argument, kept
  so it is not re-litigated from memory.
- **A question id in bold — `A1`, `D3`** — points at [questions.md](./questions.md). Nothing is
  decided in two places.
- **Where a spec says *today*, it is describing `src-dump/`**, the deleted implementation, and the
  statement is evidence rather than a plan.
