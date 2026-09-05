# Fleet

Nodes announce; the fleet reacts.

**Status: Decided in shape. Nothing built.** This is the answer to *"I need a standard way to run
services locally or in a k8s cluster."*

---

## 1. The fleet does not start processes — **Decided**

Something else always starts a process — a person, systemd, a pod. The node then joins the mesh and
says **"my name is x, what should I run?"** The fleet only ever answers.

That is why one mechanism covers a laptop and a cluster: it never had to know how a process comes to
exist, so it does not care that Kubernetes does it differently from a terminal.

**The fleet client is the single entrypoint.** One binary everywhere. Locally you start one node and
it is assigned everything — a cluster can be one process. In a cluster you start twenty and each is
assigned a slice. Same command, same image, and **no service has its own `main.ts`**.

That last point is the whole of it. The predecessor had at least seven ways to start a node —
`mesh start --services`, `mesh supervise -c`, a role wrapper binary, four manifest generators, a
hand-curated `role-services.json`, and a bespoke `MeshApp` construction in every product repository.
All of it existed because *what runs where* was baked into build artifacts instead of being an input.

## 2. Assignment is the gate, not the join — **Decided**

A node joins the mesh first. That is cheap — a namespace and a transport — and then it asks.

**A node with no assignment sits there running nothing.** That is a state you can query and explain,
which is better than a node half-admitted to a network. It also means an ad-hoc node — someone on a
laptop — joins correctly and idles, which is right, but it must *say so*: `joined as node-a7f3, no
assignment` rather than silence, or the first person to see it will think it is broken.

## 3. The fleet does both jobs — **Decided**

**What a package is.** `@flybyme/surfdns-domains` exists at 2.1.0, exporting these contracts with
these schemas. Read by a build to verify a site's `mesh[]`, and by a generator for types.

**Where it runs.** Which nodes have it mounted, at which version, and whether it is actually up.

The first is *declared*, the second splits into *desired* and *observed* — a record says a node should
run these modules; the node reports what it actually mounted, **including mount failures**. A
desired-state system whose observed side is optimistic is worthless.

## 4. Fleet depends on nothing else here — **Decided, and it must be enforced**

It is the recovery path, so it has to work when nothing else does. If fleet needed the cdn, then a
broken cdn would mean you cannot fix the cdn.

Nothing in `src/fleet/` may import from another service in this repository.

## 5. Genesis is the one static exception — **Decided**

Node 1 cannot ask the fleet what to run when the fleet is what it is being asked to run. So exactly
one node, once, is told statically — a file.

It must stay an exception that names itself. If a file is also the ordinary path for local
development, it will drift from the record-driven path and the two will disagree at the worst moment.
Local development reads its assignment from a local fleet, not from a file.

## 6. Three things to decide before the contract is written

Each has a silent failure, which is why they are worth deciding rather than discovering.

**Two nodes claiming one name.** If assignments are keyed by name and a `singleton` control loop is
assigned to it, two processes both mount it and you have split-brain with no error anywhere. The fleet
should refuse the second claim while the first is live.

**Whether a node reports what it *can* run.** If every node runs the same image, it need not. The
moment images differ, the fleet can assign something a node cannot load — and you find out as a mount
failure at runtime rather than a refusal at assignment time.

**Predefined versus generated names.** A provisioned node arrives with a name the fleet already
expects and an assignment waiting. An ad-hoc node generates one the fleet has never seen and correctly
gets nothing. Both are right; only the second is surprising.

## 7. What this replaces, and what stays

The framework's supervisor is already most of a reconciler: dynamic mount and unmount through
`registerModule` / `unregisterModule`, `dependsOn` with a topological sort and cycle detection, honest
partial-failure status, and `supervisor.*` as real contracts.

**The gap is one line**: its manifest is read once, at startup, so nothing can tell it the desired
state changed. That is why its control surface had to be imperative — commands rather than
declarations.

Two things follow that belong in the first implementation rather than after the first outage:

- **The node caches the last assignment it successfully read**, and starts from that cache when the
  fleet is unreachable — running the last known good composition and *reporting that it is doing so*,
  rather than running nothing. Today a node that cannot reach the mesh still knows what to run,
  because the manifest is on disk. Afterwards it knows nothing.
- **A local control channel stops being optional.** It is the only way into a node that cannot reach
  the mesh, and a fleet of them is exactly the scenario it exists for.

## 8. Not in scope here

**Placement.** The fleet reacts to nodes that exist; it does not decide how many there should be or
where they land. If that is ever wanted, it is a different subsystem and probably a different
repository — and it will need an answer for what happens when two things both have opinions about
placement.
