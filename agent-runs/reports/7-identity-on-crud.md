# A4: Identity on `defineCrud` Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-7`  
**Branch:** `dispatch/7`  
**Task:** **A4** — Rewrite `identity` on `defineCrud` (`src/identity/contracts/identity.contract.ts`, `src/identity/store.ts`, `src/identity/module.ts`, `test/identity/crud.test.ts`, `spec/roadmap.md`)  
**Milestone Status:** D1, D2, D3, and A4 closed. M3 continues toward D4 (exposure hash).

---

## 1. Executive Summary

Roadmap item **A4** addresses the closed, handwritten architecture of the identity subsystem:
> *20 hand-written store methods across 7 record types are what `defineCrud` generates. The line count is the smaller problem: **those records are closed**, reachable only through the 8 accessors somebody thought to write, so every new question needs a new contract and a new store method. It is the model four other services would be copied from.*

With **A4** completed:
1. **7 Record Types Defined on `defineCrud`:**
   - `user`, `organization`, `membership`, `role`, `grant`, `ticket`, and `apiToken` are now formal `defineCrud` declarations with `dependencies: []`.
   - All 10 CRUD actions (`create`, `get`, `find`, `find_one`, `count`, `update`, `delete`, `restore`, `archive`, `purge`) across all 7 collections are configured with `visibility: 'internal'`.
2. **Tenant Scoping vs. Global Records:**
   - `membership` is tenant-scoped via `scopedBy: 'organizationId'`.
   - The other 6 record types (`user`, `organization`, `role`, `grant`, `ticket`, `apiToken`) are global.
3. **8 Explicit Contracts Intact:**
   - The 8 explicit identity contracts (`identity.ticket_issue`, `identity.ticket_validate`, `identity.ticket_revoke`, `identity.sign_out`, `identity.revocations_since`, `identity.whoami`, `identity.register`, `identity.permits`) remain the public-facing doors and policy enforcement layer.
4. **Index and Storage Alignment:**
   - `mongoStore.ensureReady()` index names are aligned with `Database.ensureDomainIndexes` (`uniq_user_email`, `uniq_ticket_token`, `uniq_role_key`, `uniq_apiToken_tokenHash`, `uniq_organization_slug`, `uniq_membership_organizationId_userId`, `uniq_grant_roleKey_contract`).
   - Timestamps (`createdAt`, `updatedAt`) and ID normalization (`byId`, `toId`) ensure full interoperability between `mongoStore` and `defineCrud`'s `DomainRepository`.
5. **Zero Casts and Strict Typing:**
   - Zero `as any`, zero `as never`, zero type casts across the entire implementation.
   - An existing `as unknown as ToolContract<...>` cast in `IdentityModule` was eliminated.
6. **Full Test Verification:**
   - All 322 tests pass across 27 test files (including all 315 existing tests + 7 new comprehensive CRUD tests in `test/identity/crud.test.ts`).

---

## 2. Which Record Types Are Scoped vs. Global, and Why

| Record Type | Scoping | Rationale |
|---|---|---|
| `membership` | **Scoped** (`scopedBy: 'organizationId'`) | Memberships represent the link between a user and an organization. Tenant isolation demands that an administrator or caller in Organization A can never query, read, update, or enumerate the roster of Organization B. When accessed through CRUD actions (`membership.find`, `membership.get`, `membership.create`), mesh runtime enforces the caller's tenant boundary. Cross-tenant reads return 404, and unscoped calls are rejected with 401. |
| `user` | **Global** | A user is a principal person or identity on the platform. Users hold global credentials (email, hashed password), can be members of multiple organizations simultaneously, and authenticate *before* selecting or assuming an organization context. Scoping `user` to a tenant would force data duplication, destroy single sign-on, and prevent users from participating in multiple organizations. |
| `organization` | **Global** | Organizations are the tenant containers themselves. An organization record cannot be scoped by `organizationId` without creating a circular dependency during tenant resolution and creation. Organizations are top-level entities owned by users and looked up by ID or slug. |
| `role` | **Global** | Roles define permissions archetypes across the system (`public`, `authenticated`, `owner`, `admin`, `member`). Builtin roles are immutable platform definitions, and custom roles belong to the platform's security vocabulary. |
| `grant` | **Global** | Grants map `roleKey` and contract identifiers to authorized capabilities (e.g. `owner` -> `*`, `authenticated` -> `identity.whoami`). They constitute platform-wide policy rules evaluated during dispatch gating. |
| `ticket` | **Global** | Session tickets (`t-...`) represent authenticated sessions issued to a user. A ticket identifies the user globally across the cluster before any specific tenant route is chosen. If tickets were scoped to an organization, a user could not execute `identity.whoami` or switch organizations without obtaining separate tickets. |
| `apiToken` | **Global** | API tokens represent machine-to-machine credentials hashed with secrets. They identify service callers globally across the mesh. |

---

## 3. The Public Doors and Invariants

### The 8 Explicit Contracts
The 8 explicit contracts remain the public doors to identity:
1. `identity.register`: Creates a user and an initial organization, establishing owner membership and returning user and organization identifiers.
2. `identity.ticket_issue`: Accepts email and password, executes secure credential verification, and issues an authenticated session ticket.
3. `identity.ticket_validate`: Evaluates ticket validity, checking expiration, active status, and revocation logs.
4. `identity.ticket_revoke`: Invalidates an active ticket and appends an entry to the monotonic revocation log.
5. `identity.sign_out`: Revokes the calling ticket and optionally invalidates all active sessions for the user.
6. `identity.revocations_since`: Returns the sequence of revocations since a specified epoch for edge node cache synchronization.
7. `identity.whoami`: Inspects the caller's session context and returns principal details along with accessible organizations.
8. `identity.permits`: Evaluates whether a caller's assigned roles satisfy a required contract grant.

### Why All Generated CRUD Actions Are Internal
All 10 CRUD actions across all 7 collections are configured with `visibility: 'internal'`:
- Raw CRUD actions on identity records must **never be directly exposed as unauthenticated or public HTTP routes**.
- Exposing raw `ticket.create` would allow arbitrary session fabrication without password checks.
- Exposing raw `user.create` or `user.update` would allow unhashed password storage or arbitrary privilege escalation.
- Exposing raw `role.delete` would allow destroying builtin roles (`public`, `authenticated`) required by the runtime.
- Internal visibility ensures these contracts are only invocable by trusted internal mesh services, the broker, or administrative back-ends.

### Unscoped Reads Across the Repository
There are exactly **2** unscoped database reads in the entire codebase:
1. `src/cdn/tools/resolve_site.ts:47`  
   ```ts
   const [found] = await this.siteRepo().find({ query: { host }, limit: 1 });
   ```
   An anonymous incoming HTTP request carries no tenant context; the CDN edge must resolve the hostname to a `Site` record to establish tenant and release context.
2. `src/identity/tools/whoami.ts:25` (via `store.membershipsOf(userId)`)  
   ```ts
   const memberships = await store.membershipsOf(user.id);
   ```
   When a user signs in, their ticket establishes *who* they are, but not yet *which tenant* they are accessing. `whoami` performs an unscoped query against the membership collection filtered by `userId` to return the list of organizations the user is a member of. This allows the user's client to present an organization picker. Once an organization is chosen, all subsequent requests carry `meta.organizationId` and are strictly tenant-scoped.

Zero other unscoped database reads exist in `src/`.

---

## 4. What `defineCrud` Could Not Express

While `defineCrud` generates standard collection management tools, identity requires four domain capabilities that pure CRUD cannot express:

1. **Password Timing Oracle Protection & Hashing:**  
   `defineCrud.create` and `defineCrud.update` accept field values and insert or replace MongoDB documents. User registration and authentication require cryptographically salted password hashing (Argon2id/scrypt) and constant-time comparison (`crypto.timingSafeEqual`). CRUD cannot perform cryptographic operations or protect against timing attacks.
2. **Atomic Monotonic Counter Sequence for Revocations:**  
   Revocations form a linear, append-only log that distributed edge nodes poll via `revocations_since(epoch)`. To prevent lost updates or duplicate epochs under concurrent session revocations, `mongoStore` uses MongoDB's atomic `findOneAndUpdate` with `{ $inc: { seq: 1 } }` on a dedicated `counter` collection. `defineCrud` generates single-document CRUD and cannot coordinate cross-document atomic sequence increments.
3. **Cross-Tenant Principal Discovery (`whoami`):**  
   Under Track D's multi-tenancy model, `defineCrud` on `membership` enforces `scopedBy: 'organizationId'`. Every generated CRUD read automatically filters by the caller's tenant. However, `whoami` needs to query memberships across all tenants for a single `userId`. Generated CRUD cannot express an unscoped cross-tenant query for an authenticated user.
4. **Wildcard and Hierarchical Capability Evaluation (`permits`):**  
   The authorization engine evaluates whether a role permits a contract call using hierarchical wildcard patterns (e.g. `catalog.*`, `api.*`, or `*`). `defineCrud.find` performs direct attribute matching and basic comparison operators; it cannot evaluate capability graphs or wildcard role grant hierarchies.

These four capabilities demonstrate why the 8 explicit contracts and the `IdentityStore` interface remain essential alongside the generated CRUD collections.

---

## 5. How `memoryStore` Survived

`memoryStore()` remains completely intact in `src/identity/store.ts`:
- **Fast, Dependency-Free Unit Testing:**  
  Dozens of unit test suites in `test/identity/` and `test/api/` execute in milliseconds against `memoryStore()` without requiring a running MongoDB instance or network connections.
- **Unified Interface:**  
  Both `memoryStore` and `mongoStore` implement the exact same `IdentityStore` interface, allowing `createIdentityModule` to run with in-memory storage during unit tests and with persistent MongoDB storage in production (`bin/node.mjs`).

---

## 6. Audit Additions for `spec/unread.md`

Auditing the identity schemas against `spec/unread.md`:

| Field / Promise | Status & Reality |
|---|---|
| `roles.builtin` | Defined in `spec/unread.md` §1 as *"Shipped with identity and not deletable... No delete path checks it."* With `roleCrud` having all actions configured as `visibility: 'internal'`, external callers cannot delete roles. In `mongoStore`, `upsertRole` explicitly preserves `builtin`. If CRUD actions are ever exposed to tenants, `role.delete` must enforce `!role.builtin`. |
| `organizations.ownerId` | Formerly noted in §1 as unread. **Now actively read and enforced.** `store.transferOwnership` validates `org.ownerId !== currentOwnerId` and updates it, and `store.reownOrganization` checks `if (org.ownerId === userId)` before allowing an owner to reclaim administrative control. |
| `tickets.revokedReason`, `tickets.via` | Retained as audit logging fields under §3 ("Written for the record — leave alone"). |
| `createdAt` & `updatedAt` | Added across all 7 collections in `mongoStore` to satisfy `defineCrud`'s `outputSchema` date coercion and ensure audit trail consistency across both access paths. |
| ID Representation (`byId`, `toId`) | `mongoStore` generates prefixed IDs (`u-...`, `org-...`), while `DomainRepository` generates MongoDB `ObjectId`s. The store seamlessly handles both via `byId(key)` and `toId(id)`. |

---

## 7. Verification and Test Results

- **CRUD Integration Suite (`test/identity/crud.test.ts`):**
  - Proves caller in Organization A cannot query or read Organization B's memberships via `membership.find`.
  - Proves caller in Organization A attempting `membership.get` on Organization B's membership receives a `404 Not Found`.
  - Proves caller in Organization A attempting `membership.find_one` on Organization B's membership receives `undefined`.
  - Proves unscoped `membership.find` without tenant context is rejected with `401 Unauthorized`.
  - Proves unscoped authentication flow works end-to-end: user registers, issues ticket, validates ticket, signs out, and calls `whoami` without carrying an organization scope.
  - Proves internal CRUD queries on global identity collections (`user`, `organization`, `role`) execute successfully.
- **Strict Typing:**
  - `npm run typecheck` completed with **0 errors**.
  - **Zero `as any`, zero `as never`, zero casts.**
- **Regression Suite:**
  - `npm test` executed cleanly across all 27 test files: **322 passed (0 failed)**.
