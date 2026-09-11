# Fleet

**Which machines exist, and what each one is running.** Independent of everything in
[serving.md](./serving.md) and [building.md](./building.md): nothing about resolving a hostname or
composing a release needs to know how many nodes there are.

That independence is the point of this document. Fleet is the one part of mesh-serve that could be
lifted out and still make sense, and it should be built so that stays true.

## 1. It is one thing, not two

`fleet` and `supervisor` were separate domains. The dependency graph says otherwise: fleet calls
supervisor, and supervisor calls nothing at all. The seam between them is the direction of a single
call.

- **fleet** is the record: which nodes exist, what each is assigned, how they group.
- **supervisor** is the mechanism: starting and stopping services inside a running process.

A record with no mechanism is a control surface over nothing — which is exactly what happened.
`node.assign` failed with *"Local tool not found: supervisor.service_status"* because the node
registered every service directly, so the supervisor owned none of them and there was nothing to
switch. **Assignment had been a form you could fill in that changed nothing.**

## 2. Telemetry belongs here

`telem` was a ninth domain. It calls nothing but itself and one call into `cdn` — the only
wrong-direction edge in the whole graph.

**Metrics are about machines.** What a node is running, how hard, whether it is failing. That is the
same subject as the rest of this document, and the only reason telemetry was separate is that it was
written separately.

The current implementation is also the clearest example in the repository of what these specs exist
to prevent:

```ts
const app = (broker as unknown as { app?: { getProvider(name: string): { db?: Db; getDb?(): Db } } }).app;
const dbProvider = app?.getProvider?.('database');
const db = dbProvider?.db ?? dbProvider?.getDb?.();
if (db && this.sink instanceof CompositeSink) { … }
} catch {
    // Database provider may not be available in standalone tests
}
```

`getProvider` is **on the broker**, typed, and `onStart` is handed the broker. This casts past it to
reach an invented `.app`, guesses twice at whether the result spells it `db` or `getDb()`, and
swallows every failure — so when it does not work, telemetry silently writes nowhere and nothing
says so. The comment admits the reason: it was written to stop a test complaining.

Every rule in `spec/README.md` is broken in six lines. It is worth keeping here as the example.

## 3. What must be true

- **A node that cannot be reached is a node in an unknown state, not a node that is down.** Those
  are different and the difference matters when deciding whether to reassign its work.
- **The things that must never be switchable are the ones you need in order to switch anything:**
  the fleet itself, identity, and the api. A node that can be switched off from outside and not back
  on is a node somebody drives to a datacentre for.
- **Assignment is a desired state, not a command.** Reconciliation is what makes it true, and the
  gap between desired and observed is the thing an operator needs to see.
- **Fleet reads need a permission, including the reads.** `serve.node.find` is not public and not
  merely authenticated: what a cluster is running is operational detail. A gate looser than its
  handler is a promise the platform will not keep.
- **Nothing here is on the serving path.** A page must render on a node that cannot reach the fleet
  record at all.

## 4. Independence, concretely

Fleet may read identity, because everything resolves a caller. It must not be read *by* serving or
building. If a release ever needs to know which node it is on, that is a fact passed to it, not a
lookup it performs — otherwise the serving path acquires a dependency on a record that exists to
describe machines.

If fleet is ever lifted into its own package, the test of whether these specs were right is whether
anything in serving breaks. Today the answer is one call — `cdn` reaches `node` — and that call is
the one to look at first.

## 5. Open

What a telemetry sink writes to (**E5**), listeners as records (**D5**) and whether provisioning
belongs here (**D6**) are in [questions.md](./questions.md).
