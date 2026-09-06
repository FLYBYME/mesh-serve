# A4a: Identity Persistence (`mongoStore`) Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-4`  
**Branch:** `dispatch/4`  
**Task:** A4a — Identity does not persist anything (`src/identity/store.ts`, `bin/node.mjs`, `test/integration/identity.test.ts`, `test/identity/mongo-store.test.ts`, `spec/roadmap.md`)  

---

## 1. Executive Summary

Until now, `memoryStore()` in `src/identity/store.ts` was the sole implementation of `IdentityStore`. When `bin/node.mjs` started, all users, tickets, organizations, memberships, roles, and grants resided in heap memory (`Map` instances) and vanished the moment the process exited. An operator or user registering an account and receiving a ticket would find their account gone and their session returning `UNAUTHENTICATED` after a simple node restart.

Roadmap **A4a** provides `mongoStore(database)`, satisfying the full `IdentityStore` interface against a MongoDB database, and configures `bin/node.mjs` to mount it using the broker's database provider (`app.getProvider('database')`). Existing unit tests continue running cleanly against `memoryStore()`, and a comprehensive restart integration test proves ticket durability and account survival across distinct `MeshApp` instances.

---

## 2. What the Two Stores Differ In (Beyond Byte Storage)

While both `memoryStore()` and `mongoStore()` satisfy the ~20 methods of `IdentityStore`, their runtime guarantees differ substantially:

| Dimension | `memoryStore()` | `mongoStore(database)` |
|---|---|---|
| **Durability** | Ephemeral (heap). Reset on process exit. | Durable. Stored in MongoDB collections (`user`, `organization`, `membership`, `role`, `grant`, `ticket`, `revocation`, `counter`, `apiToken`). |
| **Natural Key Constraints** | Store-level checks absent. Calling `createUser` twice with identical emails silently creates two user objects in memory; uniqueness relied entirely on module-level `findUserByEmail` checks subject to race conditions. | Database-enforced unique indexes on natural keys: `user.email`, `ticket.token`, `role.key`, `apiToken.tokenHash`. Duplicate insertions fail at the storage engine level. |
| **Ticket Expiry & Garbage Collection** | Retained indefinitely in memory until process termination. | Swept automatically by MongoDB's native TTL background monitor via an index on `expireAt` (`expireAfterSeconds: 0`), keeping storage bounded. |
| **ID Allocation** | In-process counter (`u-1`, `u-2`). Resets to 0 on restart, risking collision if state had been reloaded. | Globally unique IDs generated via `ObjectId().toHexString()` (`u-<hex>`, `org-<hex>`, `m-<hex>`, `at-<hex>`), ensuring uniqueness across restarts and across cluster nodes without network roundtrips. |
| **Revocation Epoch Ordering** | In-memory integer counter (`epoch += 1`). Reset on restart. | Atomic sequence increment in MongoDB (`counters.findOneAndUpdate` with `$inc: { seq: 1 }`). Strictly monotonic across processes, concurrent administrators, and node restarts. |
| **Index Traversal vs. Scan** | In-memory Map key lookups or full array scans (`filter()`). | B-tree index lookups for `email`, `token`, `userId`, `role.key`, and ordered index traversal for `epoch > N`. |

---

## 3. Decisions: Expired Tickets and Revocation Ordering

### Ticket Expiry
- **Decision:** A MongoDB TTL index on `ticket.expireAt` (`expireAfterSeconds: 0`), populated with `new Date(ticket.expiresAt)` upon insertion.
- **Rationale:** 
  1. A persistent database cannot retain expired tickets forever without unbounded disk growth.
  2. Application-level sweeping (such as `setInterval` or cron jobs) requires explicit lifecycle management, risks timer leaks during shutdown, fails if a node crashes, and duplicates work when multiple cluster nodes run.
  3. MongoDB's background TTL thread runs continuously within the engine, automatically purging expired documents without application code having to remember to start a worker.
  4. For in-flight requests during the 60-second TTL sweep interval, application-level verification (`isLive(ticket, now)`) and `liveTicketsOf` filtering provide millisecond-precision invalidation.

### Revocation Ordering
- **Decision:** Atomic sequence counter stored in MongoDB (`counter` collection, document `{ _id: 'revocation_epoch' }`), incremented via `findOneAndUpdate` with `{ $inc: { seq: 1 } }` and `returnDocument: 'after'`.
- **Rationale:**
  1. Revocations form an append-only log read by API instances polling `identity.revocations_since(epoch)` to catch up on invalidated sessions.
  2. The epoch sequence must be strictly monotonic and contiguous: if two administrators revoke sessions concurrently, computing `max + 1` from a query produces a race condition where both write the same epoch and pollers miss an entry.
  3. `findOneAndUpdate` guarantees document-level atomicity: every revocation receives an incremented epoch.
  4. The `revocation` collection is indexed on `{ epoch: 1 }`, ensuring that range queries (`epoch > since`) and limit slicing execute as fast index scans.
  5. `epochRange()` queries `counter.seq` for `newest` and `revocation.findOne({}, { sort: { epoch: 1 } })` for `oldest`, preserving the exact contract that triggers `truncated` re-synchronization when a poller is too far behind.

---

## 4. What Only A4 Can Fix

Implementing `mongoStore` makes identity persistent, but it also reveals why the handwritten store pattern is an interim step rather than the final architecture. A4 (rewriting identity onto `defineCrud`) is necessary because:

1. **Closed Record Types and Rigid Query Surfaces:**  
   The `IdentityStore` interface exposes ~20 fixed methods (`getUser`, `findUserByEmail`, `membershipsOf`, etc.). Every query pattern is hardcoded. If the admin console or API needs to list users by role, query memberships by organization (`membershipsOfOrganization`), paginate users, or sort by creation date, a new method must be added to the TypeScript interface and implemented across all store backends. `defineCrud` solves this generically with standard `find`, `findOne`, `count`, `update`, and `delete` contracts.

2. **Absence of Declarative Multi-Tenant Scoping (`scopedBy`):**  
   Track D (roadmap D3) established `defineCrud(..., { scopedBy: 'tenantId' })` as the foundation for multi-tenancy: writes automatically stamp the tenant, reads are scoped to the caller's organization, cross-tenant access returns 404, and unbounded scans are structurally impossible. In `IdentityStore`, tenant checks (`transferOwnership`, `reownOrganization`, `createMembership`) are hand-coded procedural checks that can be easily missed on new methods.

3. **Missing Lifecycle Event Stream:**  
   `defineCrud` automatically publishes standardized lifecycle events on every state mutation (`user.created`, `user.updated`, `site.updated`, etc.). Currently, identity only emits `identity.ticket_revoked`. When a user's roles change or an organization updates ownership, no event is emitted on the mesh, preventing other service modules from invalidating local caches.

4. **Duplication of Validation and Schema Layers:**  
   `defineCrud` couples Zod schemas directly to MongoDB documents, managing input coercion, output formatting, and unique key violations (`CONFLICT` 409) at the framework level. In `IdentityStore`, schema parsing (`UserSchema.parse`, `TicketSchema.parse`) must be invoked manually on every read and write.

5. **Tool Registry and CLI Generation Bypass:**  
   `defineCrud` entities automatically generate typed CLI commands and API endpoints via `mesh generate` and `IServiceToolRegistry`. Identity cannot leverage this automation and requires hand-crafted tool contracts (`identityContracts`) and manual dispatching in `createIdentityModule`.

---

## 5. Audit Additions for `spec/unread.md`

During the review of `src/identity/schema/`, the following promises and schema fields were audited for readers:

| Field | Comment / Intended Promise | Reality |
|---|---|---|
| `Organization.slug` | *"Stable, and what a URL or a header names"* | Written on every organization document; **read nowhere in `src/`**. `identity.whoami` returns `organizationId`, `name`, and `roleKey`, completely omitting `slug`. |
| `ApiToken.name`, `userId`, `organizationId`, `roles` | Stored credentials for machine-to-machine authentication | Stored on API token documents; **read by no service or endpoint in `src/`** because API token authentication (`token_validate`) has no contract or handler yet. |
| `Ticket.via` | *"How it was obtained, for an audit trail: password, passkey, apiToken"* | Recorded on ticket issuance; **read nowhere in production code**. Listed under `spec/unread.md` §3 ("Written for the record — leave alone"). |

---

## 6. Verification and Test Results

- **Restart Integration Test (`test/integration/identity.test.ts`):**  
  Boots Node 1 with `DatabaseModule` and `mongoStore`, registers a user, issues a ticket, validates the ticket, and terminates Node 1. Boots Node 2 against the exact same database and successfully validates the ticket issued by Node 1. Verifies that duplicate email registrations and duplicate `store.createUser` writes fail due to the MongoDB unique index.
- **Store Unit Test (`test/identity/mongo-store.test.ts`):**  
  Validates all 26 methods of `IdentityStore` against MongoDB: users, unique email index, organization ownership transfer and reowning, memberships, roles, builtin role protection, grants, tickets, live ticket filtering, revocation logging with monotonic epochs, and API tokens.
- **Strict Typing:**  
  `npm run typecheck` passes cleanly with **zero `as any`, zero `as never`, and zero `as` type casts** across all modified and created files.
- **Test Suite:**  
  `npm test` executes cleanly: **25 test files passed, 306 tests passed** (293 pre-existing + 11 mongo-store + 2 restart integration).
- **Roadmap:**  
  `spec/roadmap.md` item **A4a** ticked.
