# The MCP service

**Status.** Proposed, 2026-09-08. Nothing is built.

A site's contracts, served to an agent as MCP tools — from the same descriptor, through the same
gate, as the HTTP api. Companion to [exposure.md](./exposure.md) and
[serving.md](./serving.md); `src/api/api.service.ts` is the worked example this follows.

## 1. Why this is a service and not a script

Today the api is the only projection of a site's exposure:

```
describeExposure  →  ApiService     →  HTTP routes
describeExposure  →  client-cli     →  a typed client
       ×          →  every MCP server, hand-written
```

`ApiService` does not decide what is callable. It **reads the descriptor** — `visibility`, the site's
grants, the gate level — and serves what is there. That is the property that keeps a generated client
honest, and it is why adding a contract adds a route without anybody editing a route table.

flowboard wrote the third row by hand, and the result is the shape this document exists to prevent:

- the tool list is a hardcoded array crossed with four hardcoded actions
- every contract declares `visibility` and **nothing reads it** — marking one `internal` changes
  nothing about what the agent can call
- the startup banner counts `crudSets.length * 4` and is wrong by five, because the orchestration
  tools are registered outside the loop
- `card_update` is public and the gates are ordinary fields on the card, so **an agent can approve
  its own merge** without the verification ever running

Every one of those is a consequence of the surface being written rather than derived. A hand-written
projection of a declared surface is a second copy of the exposure rules, and two copies of a rule is
how the first becomes wrong.

> **An MCP surface is a projection of a site's exposure, exactly as HTTP is. It is not a place where
> a person chooses what an agent may call.**

## 2. What it is

`McpService`, beside `ApiService` in `src/api/`, sharing its descriptor, its gate and its ticket
cache. It answers MCP over HTTP for a site.

```
Host → site → descriptor → gate → broker.call(key, input, { meta }) → tool result
```

The same line as the api's, with `tool` where `route` was. Every step is a lookup except the gate.

**One tool per exposed call**, named `<domain>_<action>`, with the contract's own description and its
input schema. The descriptor already carries all three; nothing is written twice.

## 3. Auth and scope — the same, not similar

**This is the part that must not be reimplemented.** `executeGate` resolves a caller from a ticket,
applies the site's grant level, and returns a scope. Its answers are already the four an agent needs
— `not_exposed`, `needs_session`, `needs_operator`, `not_ready`.

- **The ticket arrives as a header**, as it does for HTTP. An MCP client sends it the same way.
- **The scope comes from the gate, never from the request.** `api.service.ts` says it plainly: *"A
  caller names an organization in a header; the gate resolves it against their memberships and
  returns what they may actually act in."* An agent naming a tenant is a request, not a fact.
- **A refused call answers `not_exposed` rather than "no such tool"**, when the contract exists and
  this caller may not reach it. An agent that cannot tell *absent* from *refused* will retry forever,
  and a person reading its transcript cannot tell either.
- **`unauthenticated: true` on an anonymous call.** The api sets it; this must too. Absence is not a
  safe signal — an internal broker call also has no user and is expected to see everything, and
  reading "no user" as "internal" is what handed every organization on the platform to an anonymous
  HTTP caller earlier today.

**A tool list is per-caller, not per-site.** Two agents holding different tickets against one site
see different tools, because `tools/list` runs the gate the same way `tools/call` does. That is what
makes the *narrow surface* a contract rather than a convention: a worker does not see a tool it
cannot call, and does not have to be trusted not to try.

## 4. What it must refuse

- **Internal contracts, always.** `describeExposure` already refuses to publish one; this inherits
  that and does not add a bypass for "local" or "trusted" callers.
- **A tool the descriptor does not name.** No escape hatch that takes a tool key as a string.
- **A write with no confirmation, when the contract declares `destructive`.** The field exists and
  travels in the descriptor. What "confirm" means for an agent is **an open question** — see §7.

## 5. Gate levels are the multi-surface answer

flowboard mounted three MCP endpoints — `/claude` for the orchestrating session, `/agy` for a
dispatched worker, `/mcp` for everything — and that instinct is right: a worker and a manager are
different callers over one board.

**But three endpoints is the wrong mechanism, because it is three hand-maintained lists.** The right
one already exists: those are **gate levels**. A worker holds a credential that resolves to a
narrower level, `tools/list` reflects it, and the narrowing is a property of the caller rather than
of the URL they happened to use. One endpoint, and what you get depends on who you are.

The alternative — an endpoint per audience — has the same defect as a hardcoded tool array: it works
until somebody adds a tool and updates two of the three lists.

## 5a. Orchestration is contracts, not registered tools

The corollary, and the thing that makes §5 pay for itself.

flowboard's five gating tools — approve dispatch, reject, verify, approve merge, reject merge — are
registered on the MCP server by hand and call `worktree.ts` directly. So they sit *outside* the
descriptor: no `visibility`, no gate, no scope, invisible to `_describe`, and reachable by anyone who
reaches the endpoint.

**They should be ordinary contracts** on flowboard's own service, with `worktree.ts` as their
implementation. Nothing else changes and everything follows:

- they appear in `tools/list` because they are exposed calls, not because somebody listed them
- `worktree.merge` declares an operator-level gate, so **a dispatched worker's ticket cannot reach
  it** — the self-approval hole closes by construction rather than by a hook that has to remember
- they get an input schema, a description, and a place in the generated client for free
- the HTTP api serves them too, so the board's UI can drive a merge without a second mechanism

This is the same finding as `visibility` being decorative, arriving from the other side: a tool that
is not a contract is a surface nobody can review, gate, or generate a client for.

## 6. Conformance

A test that reads a descriptor and asserts the tool list is exactly the public calls in it. It fails
when a contract is added and not exposed, and when one is exposed and not offered. **That test is the
deliverable** — without it this is a second hand-written surface with better manners.

Plus: an internal contract never appears; an unauthenticated caller sees only `public` tools; a
caller whose gate refuses gets `not_exposed` and not a missing tool; `tools/list` differs between two
callers against one site.

## 7. Open

- **What confirmation means for an agent — proposed 2026-09-09, not yet built.** Raised as a
  requirement rather than an option: *"approvals need to be built in. who and how you notify."*

  The rule: **a `destructive` call reached by an agent raises an approval instead of being refused.**
  `destructive` already marks the calls that need a person, which is why the surface refuses them
  today — so the flag is reused rather than joined by a second concept. The current refusal
  (*"a person holding a session may call it"*) is true and is a dead end; this makes it a workflow.

  - **Who** — the site's `authorize` hook already answers *may this caller, and in what scope*, and
    is the only thing that knows what an organization means. Its refusal grows a
    `{ code: 'needs_approval', approver: 'role:operator' }`. A **role**, never an account, so
    approvers are not enumerated. Resolved at request time and frozen on the record: who could
    approve this must not change while it is pending.
  - **How they are told** — `approval.requested` on the existing SSE channel, scoped to the
    approver. `decideDelivery` already scopes per subscriber from memberships, so a connected board
    lights up with no new delivery path. Anything beyond a browser is a **sink**, in the mould of
    `telem` — pluggable, absent by default. With one difference from telemetry: **an approval nobody
    sees is worse than a refusal**, because the agent waits rather than failing, so an unanswered
    approval must expire loudly and visibly.
  - **How the agent learns the answer** — a two-call protocol, forced by the transport.
    `#handle` is POST-only and answers GET with 405 because *nothing here initiates anything*, so
    **there is no server push and the agent cannot be told.** `tools/call` returns
    `{ status: 'pending', approvalId, expiresAt }` as a *result*, not an error, and one universal
    tool — `approval_check` — is held by every role. Polling, because the alternative is holding an
    HTTP connection open for something a person may answer tomorrow.
  - **Where it lives** — mesh-serve. flowboard's `gate` record is this idea already
    (`{ cardId, kind, status, approvedBy, approvedAt, rejectionReason }`) built for one app; every
    app with an agent surface needs it, so flowboard's gates become a specialisation rather than the
    original.

  **Open inside the proposal:** an approval carries the **frozen input** of the call, which is
  necessary — approving `card_create` in the abstract approves nothing — and means the record holds
  whatever the agent was about to write, readable by every approver in the role. Storage and
  retention want deciding before the first sensitive payload, not after.
- **Whether the MCP port is the api's port.** One process is one less thing to be half-running;
  separate ports are one less thing to get wrong in a proxy. flowboard just folded three processes
  into one and has an opinion.
- **Streaming.** The api has SSE for events. MCP has its own notion. Not needed for a first cut, and
  the shape of the answer should not be guessed at now.
