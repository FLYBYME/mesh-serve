# C5 & C6: Artifact Durability Report (Milestone M2)

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-5`  
**Branch:** `dispatch/5`  
**Tasks:**
- **C5**: Artifact sync between edges (`src/cdn/cdn.service.ts`, `src/builder/blobs.ts`)
- **C6**: `gone` state and rebuild from catalog commit (`src/builder/schema/artifact.ts`, `src/builder/methods/publish.ts`, `src/cdn/cdn.service.ts`)
- **Tests**: `test/integration/durability.test.ts` (4 integration tests)  
- **Milestone Status**: M2 Closed — "An edge is a cache and git is the archive."

---

## 1. Executive Summary

Milestone M2 states:
> *An edge is a cache and git is the archive. Kill an edge's storage, restart it, and the site still serves — either because another edge had the bytes, or because the artifact went `gone` and was rebuilt from the catalog's commit.*

Prior to this work, `mesh-serve` assumed a single serving node. An edge that lost its disk or restarted with an empty memory store would simply fail with 404/500 errors when asked for artifact assets.

With **C5** and **C6** implemented:
1. Every edge serves a raw content-addressed HTTP endpoint: `GET /blobs/:digest`.
2. When an edge cache misses on a requested file, it queries the `edge` registry to fetch the missing content-addressed blob from peers over HTTP.
3. Arriving bytes are cryptographically validated against their sha256 digest before being written to disk or memory; corrupted bytes are rejected and skipped.
4. Concurrent requests for the same missing digest coalesce in-memory via singleflight Promise tracking, preventing duplicate fetches, stampedes, and filesystem write races.
5. If no peer edge holds the blob, the discovering edge marks the `artifact` and `partVersion` as `state: 'gone'` in MongoDB, and triggers `builder.build_start` using the catalog's immutable repository commit and the publisher's tenant credentials.
6. The deterministic build recreates the exact bytes, restores the artifact state to `'available'` and version state to `'built'`, and serves the client request with 200 OK.
7. All 310 tests pass across the repository with zero TypeScript errors and zero `as ...` casts.

---

## 2. The Three C5 Architectural Decisions

The roadmap posed three fundamental decisions for peer artifact sync:

### Decision 1: How a Request That Misses Is Handled
- **Alternative 1 (Async background fetch with 202 / retry header):** Return `202 Accepted` or `503 Retry-After` to the browser while fetching in the background.  
  *Rejected*: Standard browser `<script>` and `<link>` tags do not understand `202` or `Retry-After`. A browser asset load that receives anything other than `200 OK` (or `304 Not Modified`) fails permanently, breaking page rendering.
- **Alternative 2 (Blocking inline await with timeout):** The request that discovers the miss awaits peer retrieval inline.  
  *Adopted*: A peer fetch over internal HTTP has sub-millisecond latency within a cluster. We dial peers with an explicit 2-second timeout per peer (`httpFetchBlob(url)`). If all peers miss or fail, the request immediately falls back to `rebuildMissingBlob`, awaiting the deterministic build and returning `200 OK` once rebuilt. Only if both peer sync and rebuild fail does the edge return `504 Gateway Timeout`.

### Decision 2: How Concurrent Misses Are Handled
- **Problem**: When a new version is deployed or a pod restarts, hundreds of browser clients simultaneously request `/_a/<digest>/index.js`. Without coordination, every concurrent request would dial peer edges or trigger duplicate builds, causing thundering herds, stampedes, and disk write collisions.
- **In-Memory Singleflight Coalescing:**  
  `CdnService` maintains an in-memory `inFlightBlobs = new Map<string, Promise<Buffer | undefined>>()`. When a miss occurs:
  - If a Promise for `digest` already exists in `inFlightBlobs`, the request joins the existing Promise.
  - If not, it creates and stores `this.resolveBlob(digest, artifact)` in the map.
  - Upon completion (or failure), `this.inFlightBlobs.delete(digest)` cleans up the map in a `finally` block.
- **Atomic Staging Collisions (`src/builder/blobs.ts`):**  
  `fileBlobStore` writes content to a temporary staging file before atomically renaming it to `<root>/ab/cdef...`. Previously, the staging filename was `${path}.${process.pid}.tmp`. If multiple concurrent workers within the same node attempted to stage the same digest, they could truncate each other's staging files. We updated staging to `${path}.${process.pid}.${randomToken}.tmp` so every concurrent write operates on a completely isolated staging file.

### Decision 3: Rejection of Corrupted Peer Bytes
- **Rule: Content addressing is a guarantee, not a convention.**  
  An edge must never trust bytes sent by a peer simply because the peer returned `200 OK`.
- **Validation Before Storage:**  
  In `fetchBlobFromPeers`, as soon as bytes arrive over HTTP, `CdnService` computes:
  ```ts
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
  if (actual !== digest) {
      this.broker?.logger.warn(`Rejecting corrupted blob from peer ${peer.url}...`);
      continue;
  }
  await this.blobs.put(digest, bytes);
  ```
  If the hash does not match `digest`, the payload is immediately dropped without being stored to `this.blobs`. The loop continues to the next peer. If no valid peer responds, it falls back to rebuilding from git. Verified end-to-end in Test 3 of `test/integration/durability.test.ts`.

---

## 3. The Semantics of `gone` and Process Restart

### An Observed State, Never a Desired State
Roadmap C6 notes:
> *No edge holds it → mark the artifact gone → rebuild from the catalog's commit. Safe because the build is deterministic.*

- **Schema Update (`src/builder/schema/artifact.ts`):**
  ```ts
  export const ArtifactStateSchema = z.enum(['available', 'gone']);
  ```
  Added `state: ArtifactStateSchema.default('available')` to `ArtifactSchema`.
- **Why `gone` is written to MongoDB:**  
  If `gone` were kept only in an edge's memory, an edge restarting mid-incident would lose the knowledge that storage was lost. Storing `artifact.update({ id, state: 'gone' })` and `partVersion.update({ id, state: 'gone' })` in the database informs the entire cluster:
  - Other edges querying `artifactFor` or `ensureArtifactBlobs` see `state === 'gone'` and bypass stale local pointers.
  - The builder's `cachedArtifact` checks `artifact.state !== 'gone'`. If `state === 'gone'`, it refuses to return the cached build record, forcing esbuild to fetch from git and write fresh blobs.
- **Process Restart During Rebuild:**  
  If the edge or builder crashes while an artifact is `gone`:
  1. The MongoDB records remain `state: 'gone'`.
  2. When the node restarts and receives the next incoming request, `state: 'gone'` is detected immediately.
  3. The node re-enters `builder.build_start`.
  4. Once bundling finishes, `publishPart` writes the blobs, sets `existing.state = 'available'`, updates the database row, and transitions `partVersion.state = 'built'`.
  5. The cluster state is fully recovered.

---

## 4. The Milestone Verdict: Is M2 Actually Closed?

### The M2 Verification Suite (`test/integration/durability.test.ts`)
To prove Milestone M2 across real network sockets, real MongoDB, and multiple running `CdnService` instances, we authored 4 full integration tests:

1. **Test 1 — Loss of disk, peer has it:**  
   - Node 1 has `fileBlobStore` containing the built artifact.  
   - Node 2 has `memoryBlobStore()` holding nothing.  
   - Client requests `/_a/<digest>/index.js` from Node 2.  
   - Node 2 fetches from Node 1 over HTTP, serves 200 OK with correct JavaScript, and caches the blob in Node 2's store. Node 2 also serves the root page with 200 OK.
2. **Test 2 — Nobody has it, rebuild from commit:**  
   - Both Node 1 disk storage and Node 2 memory storage are completely wiped. Neither edge holds the blobs.  
   - Client requests `/_a/<digest>/index.js` from Node 2.  
   - Node 2 peer fetch returns 404; Node 2 marks `artifact` and `partVersion` as `gone`, triggers `builder.build_start` with publisher tenant meta, deterministically rebuilds from git, fetches the reconstituted blob, and answers 200 OK.  
   - In MongoDB, `artifact.state` is verified to be `'available'`, `partVersion.state` is `'built'`, and rebuilt digest equals original digest.
3. **Test 3 — Corrupted peer response rejected:**  
   - A rogue/corrupt HTTP server is registered in the edge registry returning corrupted garbage for `/blobs/<digest>`.  
   - Edge 2 dials the peer, detects hash mismatch, discards the payload without writing to storage, falls back to rebuild, and answers 200 OK with clean code.  
   - Asserted that `cdn2.blobs` contains valid bytes and never corrupted garbage.
4. **Test 4 — Concurrent misses:**  
   - Edge 2 has an empty cache. 20 parallel requests fire simultaneously for the same missing artifact file.  
   - All 20 requests join the singleflight Promise, succeed with status 200, and return identical body content without race conditions.

### Verdict: M2 is CLOSED
The core premise of M2 ("an edge is a cache and git is the archive") is completely realized. An edge requires no persistent volume to guarantee durability; ephemeral storage loss is self-healing.

### Explicitly Noted Assumptions & Scope Limits:
1. **Git commits remain reachable:** Durability relies on the catalog's repository URL and commit hash remaining cloneable by the builder. (Track A5c notes that tarball uploads without git backing are not durable until an archive store is defined).
2. **Eviction (C7) is deferred:** Artifacts are rebuilt when missing or marked `gone`, but automated refcounted eviction of unused releases (C7) is a separate roadmap item.
3. **Flat Part Namespace:** As noted in the roadmap, part names in the catalog are currently a global namespace.

---

## 5. What a Second Edge Needs Before Multi-Machine Production

While C4, C5, and C6 work seamlessly across multiple nodes on a local or containerized mesh, a multi-machine production deployment across heterogeneous servers will need:

1. **Mutual Authentication / HMAC on `/blobs/:digest`:**  
   Currently, `/blobs/:digest` is an open HTTP endpoint on the edge port. Content addressing ensures a client or peer cannot inject malicious bytes (because any tampering invalidates the sha256 hash). However, an unauthenticated endpoint allows arbitrary clients on the internal network to probe or exhaust edge disk I/O. Production multi-machine edges should require a shared cluster secret, mTLS, or signed JWT.
2. **Consistent Hashing / Rendezvous Peering (Rendezvous / Ring Routing):**  
   In C5, an edge queries peers by linear iteration through `edge.find({})`. In a 5-node cluster, linear iteration is negligible. In a 50-node edge cluster, linear probing causes $O(N)$ HTTP dials on a cold miss. Edges should use rendezvous hashing (HRW) or consistent hashing on `digest` to query the 2 or 3 specific peer edges designated to hold that hash partition before falling back to rebuild.
3. **Rate Limiting and Concurrency Caps on Peer Dials:**  
   To prevent cascaded timeouts if a builder is under load, edge nodes should cap the number of concurrent peer HTTP requests via a connection pool / semaphore.
4. **Network Topology & Private Hostnames:**  
   Nodes must be configured with their routable internal DNS or private IP via `--cdn-url` (e.g. `http://edge-2.internal:8080`), ensuring edges running on separate VMs or cloud subnets can dial each other directly.

---

## 6. Audit & Unread Updates

- **`edge.url` (`src/cdn/schema/edge.ts`):**  
  Previously identified as having no production reader (read only by `test/integration/edge.test.ts`).  
  **Resolved**: Now has an active production reader in `src/cdn/cdn.service.ts` (`fetchBlobFromPeers`), which dials `${peer.url}/blobs/${digest}`. Updated in `spec/unread.md`.
- **`artifact.state` (`src/builder/schema/artifact.ts`):**  
  Added `'available' | 'gone'`. Production readers in `src/cdn/cdn.service.ts` (`ensureArtifactBlobs`, `rebuildMissingBlob`) and `src/builder/methods/publish.ts` (`cachedArtifact`).
- **`partVersion.state`:**  
  Transitioned to `'gone'` during edge rebuild, and back to `'built'` upon completion.
- **`spec/roadmap.md`:**  
  C5 and C6 checked off; Milestone M2 marked completed.
