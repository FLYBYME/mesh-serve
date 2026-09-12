# Fleet

**Which machines exist, and what each one is running.** Independent of everything in
[serving.md](./serving.md) and [building.md](./building.md): nothing about resolving a hostname or
composing a release needs to know how many nodes there are.

**That independence is the point of this document.** Fleet is the one part of mesh-serve that could be
lifted into its own package and still make sense, and it should be built so that stays true.

**None of this is built.** Where this document quotes code or names a failure, it is describing
`src-dump/`, the deleted implementation.

---

## 1. It is one thing, not two

`fleet` and `supervisor` were separate domains. The dependency graph says otherwise: fleet calls
supervisor, and supervisor calls nothing at all. **The seam between them is the direction of a single
call.**

- **fleet** is the record: which nodes exist, what each is assigned, how they group.
- **supervisor** is the mechanism: starting and stopping services inside a running process.

A record with no mechanism is a control surface over nothing — which is exactly what happened.
`node.assign` failed with *"Local tool not found: supervisor.service_status"* because the node
registered every service directly, so the supervisor owned none of them and there was nothing to
switch. **Assignment had been a form you could fill in that changed nothing.**

That is the strongest argument in these specs for a record and its mechanism living together: the gap
between them was invisible from either side and only appeared when somebody used it.

---

## 2. The records

```
node            hostname        the key
                nodeID          the broker's own id, when connected
                services[]      desired. What this node should run
                groups[]        which groups it belongs to

group           name
                services[]      desired, for every member
                description?

serviceRun      name            observed, from the supervisor
                domain?
                status          stopped | running | error
                dependsOn[]
                error?
```

**`node.services` is desired and `serviceRun.status` is observed, and they are different words on
purpose.** A record that used one field for both cannot express the only interesting state, which is
the gap.

A node's status report carries both, plus its peers, plus every node it can see — so an operator
looking at one node learns what that node believes about the cluster, which is not the same as what is
true and is exactly what you need when diagnosing a split.

---

## 3. Telemetry belongs here

`telem` was a ninth domain. It calls nothing but itself and one call into `cdn` — **the only
wrong-direction edge in the whole graph.**

**Metrics are about machines.** What a node is running, how hard, whether it is failing. That is the
same subject as the rest of this document, and the only reason telemetry was separate is that it was
written separately.

Its implementation is also the clearest example in the repository of what these specs exist to
prevent:

```ts
const app = (broker as unknown as { app?: { getProvider(name: string): { db?: Db; getDb?(): Db } } }).app;
const dbProvider = app?.getProvider?.('database');
const db = dbProvider?.db ?? dbProvider?.getDb?.();
if (db && this.sink instanceof CompositeSink) { … }
} catch {
    // Database provider may not be available in standalone tests
}
```

Six lines, and every rule in [README.md](./README.md) is broken in them:

| | |
| --- | --- |
| `getProvider` is **on the broker**, typed, and `onStart` is handed the broker | rule 2 |
| it casts past that to reach an invented `.app` | rule 2 |
| it guesses **twice** whether the result spells it `db` or `getDb()` | rule 5 |
| it swallows every failure, so telemetry silently writes nowhere | rule 8 |
| the comment admits the reason: it was written to stop a test complaining | — |

**When it does not work, nothing says so.** A metrics sink that writes nowhere and reports success is
worse than no metrics, because somebody will trust the empty graph.

What it should be is decided once and injected — **E5**.

---

## 4. Desired, observed, and the gap

**Assignment is a desired state, not a command.**

```
   desired ──── node.services ∪ group.services for every group
      │
      │   reconcile
      ▼
  observed ──── serviceRun[] from the supervisor
      │
      └── the gap is the thing an operator needs to see
```

Reconciliation is what makes desired true. It must be:

- **Idempotent.** Running it against a converged node changes nothing and says so.
- **Reported per service.** *"Reconcile failed"* on a node running fourteen services is not an answer.
- **Safe to run concurrently.** Two reconciles must not fight, because a supervisor and an operator
  will both trigger one.

---

## 5. What must be true

- **A node that cannot be reached is a node in an unknown state, not a node that is down.** Those are
  different, and the difference decides whether its work gets reassigned. A record that collapses them
  will eventually double-run something.
- **The things that must never be switchable are the ones you need in order to switch anything:** the
  fleet itself, identity, and the api. **A node that can be switched off from outside and not back on
  is a node somebody drives to a datacentre for.**
- **Fleet reads need a permission, including the reads.** `serve.node.find` is not public and not
  merely authenticated: what a cluster is running is operational detail.
- **Nothing here is on the serving path.** A page must render on a node that cannot reach the fleet
  record at all.
- **Provisioning is not assignment.** Creating a machine reaches a cloud provider — credentials,
  billing, an API that is not ours. Recording and reconciling could stay while provisioning leaves
  (**D6**).

---

## 6. Independence, concretely

Fleet may read identity, because everything resolves a caller. **It must not be read *by* serving or
building.**

If a release ever needs to know which node it is on, that is a fact passed to it, not a lookup it
performs — otherwise the serving path acquires a dependency on a record that exists to describe
machines, and a page stops rendering when the fleet collection is slow.

**The test of whether these specs were right** is whether anything in serving breaks when fleet is
lifted into its own package. Today the answer is one call — `cdn` reaches `node` — and that call is
the one to look at first.

---

## 7. Open

What a telemetry sink writes to (**E5**), listeners as records (**D5**) and whether provisioning
belongs here (**D6**) are in [questions.md](./questions.md).

**D5 is the seam that is not drawn.** Every projection needs an address to listen on, and those are
facts about a node — so the ports table lives here while the thing that binds them lives in serving,
and nothing currently says how they meet.
