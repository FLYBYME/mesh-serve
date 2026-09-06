# C4: The Edge Registry Report (Milestone M2)

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-3`  
**Branch:** `dispatch/3`  
**Task:** C4 — The edge registry (`src/cdn/schema/edge.ts`, `src/cdn/contracts/edge.contract.ts`, `src/cdn/cdn.service.ts`, `bin/node.mjs`)  

---

## 1. The Schema and Restraint (`id` and `url`)

Roadmap M2 states:
> *One row per running edge: id and url. That is genuinely the whole schema, and the restraint is the design.*

### The Implementation
- **Schema (`src/cdn/schema/edge.ts`):**
  ```ts
  export const EdgeSchema = z.object({
      url: z.string().min(1),
  }).strict();
  ```
- **Contract (`src/cdn/contracts/edge.contract.ts`):**
  ```ts
  export const edgeCrud = defineCrud('edge', EdgeSchema, {
      pluralPath: 'edges',
      dependencies: [],
  });

  export type Edge = z.infer<typeof edgeCrud.outputSchema>;
  ```

### Why `id` is not in `EdgeSchema`
In `@flybyme/mesh`, `defineCrud` explicitly enforces that the document ID field (`idField`, default `'id'`) must *not* be defined in `baseSchema.shape` (it throws a runtime error if present). The database layer mints and handles document IDs automatically, and `outputSchema` appends `id: z.string()`, `createdAt: z.date()`, and `updatedAt: z.date()`. Thus, the returned `Edge` record contains `id` and `url`.

### Scoping and Exposure
- **Scoping: Global (unscoped).** An edge is platform infrastructure, not a tenant's asset. Edge nodes cache content-addressed blobs that are shared across tenants; an edge serves any site routed to it. Scoping the collection by `tenantId` would make edge discovery tenant-partitioned and prevent global peer blob sharing.
- **Exposure: Internal only.** `visibility` defaults to `internal` across all actions (`find`, `findOne`, `get`, `create`, `delete`, etc.). No external user, browser, or tenant client has any reason to query or enumerate platform edge servers.

---

## 2. Every Field Considered and Rejected

The list of rejected fields is the entire design argument for C4:

1. **`lastSeen` / `heartbeat` / `updatedAt` (Rejected — Liveness belongs to the mesh):**  
   The roadmap explicitly rejects liveness in the registry: *"the mesh already knows which nodes are up, and a second heartbeat beside it is two sources of truth that disagree during exactly the incident where it matters."* The mesh already maintains WebSocket connection heartbeats via `RegistryModule`. A heartbeat column in mongo creates a dual-source-of-truth problem during network partitions.

2. **`healthy` / `status` (`'online' | 'offline' | 'draining'`) (Rejected — Ephemeral status drifts):**  
   Any stored health status in a database quickly diverges from reality. An edge that crashes doesn't update its status to `'offline'`. If C5 relied on `status === 'online'`, a crashed edge whose status hadn't yet been flipped would still be queried; conversely, a transient health probe failure might take an edge out of service unnecessarily. C5 learns reachability by attempting to fetch over HTTP and failing.

3. **`nodeId` (Rejected — Redundant with the mesh control plane):**  
   The broker already assigns and tracks `nodeID` (`app.nodeID`). But peer blob retrieval in C5 happens over HTTP, not over the broker (because a kernel bundle is megabytes and the broker is for control messages). What a peer needs to know is the HTTP `url` to dial, not the mesh node ID.

4. **`tenantId` (Rejected — Infrastructure is not tenant-owned):**  
   Edges are shared infrastructure. Storing a tenant ID would partition edge nodes by tenant, breaking multi-tenant content-addressed caching.

5. **`region` / `datacenter` / `zone` (Rejected — Routing topology is fleet/DNS concern):**  
   Geographic locality and topology belong to DNS, reverse proxies (e.g. surfdns), or Fleet assignment (Track E), not to the basic blob-fetch edge registry.

6. **`heldArtifacts` / `blobCount` / `inventory` (Rejected — Centralized inventory bottleneck):**  
   Tracking which edge holds which blob inside MongoDB would turn the database into a bottleneck on every build and cache fetch. In M2/C5, edges announce availability at artifact granularity via mesh events and fetch at blob granularity, without updating a central database inventory.

7. **`load` / `cpu` / `diskUsage` (Rejected — High write-churn metric pollution):**  
   Runtime metrics create constant write pressure in mongo and are immediately stale.

8. **`unique: [{ fields: 'url', scope: 'global' }]` (Rejected — Blocks crash restart):**  
   We considered placing a unique database index on `url`. However, when an edge dies uncleanly (SIGKILL, power failure), its row remains in MongoDB. If `url` had a unique index, when the restarted edge on the same host attempts `edge.create({ url })` on boot, MongoDB would reject the write with a `409 CONFLICT` duplicate key error. Omitting `unique` ensures that a restarted edge can always register immediately.

---

## 3. How a Node Learns Its Own URL

### The Finding in `bin/node.mjs`
Before this change, `bin/node.mjs` accepted `--cdn` (default `8080`) for the bind port, but had no flag or environment variable for the edge's advertised/public URL. It printed `cdn http://127.0.0.1:${cdnPort}` to stdout, but passed only `{ port: cdnPort, blobRoot }` into `CdnService`. `CdnService` listened on `options.host ?? '0.0.0.0'`, which cannot be dialed by a peer (`0.0.0.0` dials loopback).

### The Decision
- Added `--cdn-url` CLI flag to `bin/node.mjs`, falling back to `process.env.CDN_URL` and defaulting to `http://127.0.0.1:${String(cdnPort)}`.
- Added `url?: string` to `CdnServiceOptions`.
- If `url` is explicitly configured, `CdnService` uses it.
- If `url` is omitted (standard for tests using dynamic ephemeral port `port: 0`), `CdnService` derives its URL after binding: `http://127.0.0.1:${String(this.port)}`.
- **What was rejected:** Scanning `os.networkInterfaces()`. Inspecting local network interfaces is brittle: it frequently picks internal Docker bridges (`docker0`), VPN adapters (`tun0`), or non-routable IPs unpredictably. A flag with an honest local default is deterministic, explicit, and cloud/container-friendly.

---

## 4. What Happens When an Edge Dies Without Removing Its Row

### Clean Shutdown
On normal termination (`onStop` / `SIGINT` / `SIGTERM`), `CdnService.onStop()` deletes its registered edge row via `edge.delete({ id: this.edgeId })`.

### Unclean Exit (Crash / Power Loss / SIGKILL)
When an edge process crashes, `onStop()` does not run, and its row remains in MongoDB.
**Why this is acceptable rather than a gap:**
- C5 connects to peer edges over HTTP to fetch missing blobs.
- If C5 tries to fetch from an edge that died, the HTTP connection fails (`ECONNREFUSED` or timeout). C5 catches this error and proceeds to the next peer in the registry.
- Even if the registry attempted to maintain a heartbeat/status, there is an unavoidable race condition: a node can crash milliseconds after a heartbeat. Any peer fetcher must handle connection failure gracefully regardless.
- Therefore, the network fetch attempt is the **only true source of truth**. Leaving the dead row in the database causes no correctness issues.

---

## 5. What C5 Will Need From This That Is Not Here Yet

C4 provides the directory of peers. To build C5 (artifact sync between edges), the following must be added:
1. **HTTP Peer Blob Endpoint:** An HTTP route on `CdnService` (e.g. `GET /_blob/<digest>`) allowing peer edges to download raw content-addressed blobs.
2. **Peer Selection & Probing:** A sync client in `CdnService` that calls `edge.find({})`, filters out its own edge ID, selects peer URLs, and initiates HTTP blob downloads.
3. **Blob Ingestion:** Saving downloaded peer blobs directly into the local `BlobStore` (`fileBlobStore`).
4. **Artifact Announcements:** Announcing newly composed or built artifacts over the mesh so peers know who holds what.

---

## 6. Entry for `spec/unread.md`

`spec/unread.md` documents fields that have no readers in production code.

**Finding:** `edge.url` is written on every edge start (`edge.create`), but currently has no production reader in `src/` (read only in `test/integration/edge.test.ts`).

- **Category:** §2 (*"Read only by their own tests — the sharpest category"*).
- **Status:** Intentional staging for Roadmap M2. C4 exists specifically to lay the registry ground for C5. Building C4 and C5 simultaneously was explicitly forbidden to avoid rushing sync protocol decisions. C5 will become the production reader of `edge.url`.
