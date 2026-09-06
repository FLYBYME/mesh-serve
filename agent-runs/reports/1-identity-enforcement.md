# Identity Enforcement Report: Roadmap F3 & F8

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-1`  
**Branch:** `dispatch/1`  
**Issues addressed:** Roadmap F3 (`Role.scope`), Roadmap F8a (`roles.builtin`), Roadmap F8b (`principals.ownerId`, surfdns #29).

---

## 1. What Each of the Three Enforcement Rules Turned Out to Be

### F3: `Role.scope` (`cluster` vs. `organization`)
The role scope field was designed to prevent surfdns #26 (where role names like `admin` were conflated between platform-wide operator access and tenant-specific access). The enforcement covers both authorization time and write points:
1. **Authorization Time (`permits`)**:
   - Roles with `scope: 'cluster'` grant permissions unconditionally across the entire platform, regardless of whether an `organizationId` is present in the caller's context.
   - Roles with `scope: 'organization'` grant permissions **only** when an `organizationId` is explicitly provided in the evaluation context.
2. **Write Points (`store.createUser`, `store.updateUser`, `store.createMembership`)**:
   - `user.roles` represents global/cluster identity. Attempting to assign an organization-scoped role to `user.roles` is rejected with `ClientError` (`INVALID_ROLE_SCOPE`, 400).
   - `membership.roleKey` represents role assignment within a specific organization. Attempting to assign a cluster-scoped role to `membership.roleKey` is rejected with `ClientError` (`INVALID_ROLE_SCOPE`, 400).

### F8a: `roles.builtin`
Builtin roles represent foundational system roles required for platform operation.
- Calling `store.deleteRole(key)` checks `role.builtin`.
- If `role.builtin === true`, the deletion is refused with `ClientError` (`BUILTIN_ROLE`, 400):  
  `Cannot delete builtin role "${key}": builtin roles are shipped with identity and not deletable.`

### F8b: `principals.ownerId` (surfdns #29)
The schema promised that `ownerId` was recorded as a field on `Organization` rather than inferred from memberships so that the answer is always available even if no owner memberships remain.
- **Authority**: `ownerId` on the `Organization` document is the sole authority for organization ownership.
- **Transfer**: `store.transferOwnership(organizationId, currentOwnerId, newOwnerId)` is the only path that updates `ownerId`. It verifies that the caller matches `org.ownerId` (throwing `NOT_OWNER`, 403 otherwise), updates `ownerId`, and ensures `newOwnerId` holds an active `owner` membership.
- **Resilience / Recovery**: When memberships are removed or if the last owner's membership is deleted, the organization is not permanently unadministerable. `store.reownOrganization(organizationId, userId)` permits the user recorded in `organization.ownerId` to restore their owner membership at any time, even when zero active memberships exist.

---

## 2. The `permits` Signature Decision and Rationale

**Chosen Signature:**
```typescript
export function permits(
    roles: readonly (Role | string)[],
    grants: readonly Grant[],
    contract: string,
    organizationId?: string,
): boolean
```

### Why Passing `Role` Records is Superior to Making `permits` Async
1. **Purity and Performance**:
   - `permits` is invoked on critical hot paths (evaluating whether an action is permitted).
   - Embedding asynchronous database lookups inside `permits` causes hidden I/O, latency amplification, and potential N+1 queries during bulk permission checks.
   - Keeping `permits` pure and synchronous preserves deterministic, fast evaluation.
2. **Layering and Responsibility**:
   - The contract handler `identity.permits` in `src/identity/module.ts` already executes in an async context with access to `store.listRoles()`. Resolving string keys to `Role` rows at the service boundary cleanly separates storage lookup from access control evaluation.
3. **Ergonomics & Compatibility**:
   - By accepting `(Role | string)[]`, built-in role keys (`'public'`, `'authenticated'`) are auto-resolved from `BUILTIN_ROLES` without requiring callers to fetch them from the database, while user-defined roles pass their parsed `Role` rows.

---

## 3. Which of `public` / `authenticated` Was Wrong About `builtin`

**`authenticated` was wrong in `BUILTIN_ROLES`.**

The schema docstring for `RoleSchema.builtin` explicitly stated:
> *"Shipped with identity and not deletable. Only `public` is, because a deployment with no `public` role has no way to answer an anonymous request at all — and that is a state it should not be possible to configure into."*

However, `BUILTIN_ROLES` in `src/identity/schema/roles.ts` was defined as:
```typescript
export const BUILTIN_ROLES: readonly Role[] = [
    { key: PUBLIC_ROLE, name: 'Public', scope: 'cluster', builtin: true },
    { key: 'authenticated', name: 'Authenticated', scope: 'cluster', builtin: true },
];
```

`authenticated` is a genesis seed convenience, but not undeletable: a platform deployment could customize or revoke default authenticated roles without breaking the baseline anonymous request routing. Without `public`, anonymous requests cannot be dispatched at all.  
We corrected `authenticated` to `builtin: false`, aligning code with the invariant.

---

## 4. Rule for surfdns #29: What Happens When the Last Owner Leaves

### The Rule:
1. Ownership is anchored in `Organization.ownerId`, not in the membership collection.
2. Membership deletion (`store.deleteMembership`) removes the membership row, but does not alter `organization.ownerId`.
3. If an owner leaves or all owner memberships are removed, the organization document retains `ownerId`.
4. The user whose ID matches `organization.ownerId` retains authoritative ownership rights:
   - They can call `store.reownOrganization(organizationId, userId)` to recreate/restore their `owner` membership.
   - They can call `store.transferOwnership(organizationId, currentOwnerId, newOwnerId)` to designate a new owner.
5. No non-owner user can re-own or transfer ownership of the orphaned organization.

This ensures an organization is never permanently stranded, directly resolving surfdns #29.

---

## 5. Tests Defending Old Behaviour

When running the test suite after introducing enforcement, two test suites failed because they were asserting or relying on the defective behavior:

1. **`test/identity/roles.test.ts:35`**:
   ```typescript
   expect(BUILTIN_ROLES.every((r) => r.builtin)).toBe(true);
   ```
   This assertion was explicitly defending the bug where `authenticated` was marked `builtin: true`, directly contradicting the schema comment. Updated to assert `PUBLIC_ROLE` is `builtin: true` and `authenticated` is `builtin: false`.

2. **`test/identity/roles.test.ts:47` & `test/identity/module.test.ts:257, 279, 298`**:
   - `roles.test.ts` passed bare strings (`'author'`, `'operator'`) to `permits` without `Role` definitions or scope awareness, asserting that arbitrary strings granted permissions globally.
   - `module.test.ts` assigned arbitrary string roles (`operator`, `author`, `owner`) in `updateUser` and `createMembership` without the roles existing in the role store.
   - Once write-point validation was active, the store correctly rejected these unregistered roles. The test setups were updated to create the role definitions with their appropriate `cluster` or `organization` scopes before assigning them.

---

## 6. Candidates for `spec/unread.md`

During close inspection of `src/identity/` and related schemas, two additional unread fields were identified:

1. **`Organization.slug`** (`src/identity/schema/principals.ts`):
   - Comment promises: *"Stable, and what a URL or a header names"*.
   - Reality: Never read anywhere in `src/`. `whoami` returns `organizationId` and `name`, API routing and multi-tenancy operate strictly on `organizationId` / `tenantId`, and no queries filter by `slug`.
2. **`ApiToken.name`, `ApiToken.roles`, `ApiToken.organizationId`** (`src/identity/schema/tickets.ts`):
   - Written at token creation, but no execution path, authentication check, or ticket verification currently inspects `ApiToken.roles` or `ApiToken.organizationId`.

---

## 7. Verification Summary
- Pre-change failure verification: Created 10 targeted tests in `test/identity/enforcement.test.ts` that all failed before implementation.
- All 20 test files and 271 tests passing (`npm test`).
- Type check clean with zero errors (`npm run typecheck`).
- Zero `as any`, zero `as never`, zero casts in written code.
- Roadmap items **F3** and **F8** marked as completed in `spec/roadmap.md`.
