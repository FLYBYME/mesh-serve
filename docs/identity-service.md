# Identity & Access Control

The [`IdentityService`](file:///home/ubuntu/code/mesh-serve/src/identity/identity.service.ts#L37) (`identity`) manages multi-tenant accounts, organizations, memberships, session tickets, persistent API tokens, and Role-Based Access Control (RBAC).

---

## Domain Model & Schemas

### 1. [`User`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/user.contract.js) (`identity.user`)
Represents an authenticated account:
* `username`: Unique login handle.
* `email`: Primary email address.
* `password`: Salted password hash in `<saltHex>:<hashHex>` format.
* `roles`: Global roles granted directly to the account (e.g. `["operator"]`).
* `status`: Account state (`active` or `provisional`).

### 2. [`Organization`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/organization.contract.js) (`identity.organization`)
The fundamental tenant boundary for `@flybyme/mesh-serve`:
* `slug`: URL-safe identifier (e.g. `platform`, `acme`).
* `name`: Human-readable organization name.
* `ownerId`: User ID of the organization administrator.

### 3. [`Membership`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/membership.contract.js) (`identity.membership`)
Binds an account to an organization:
* `organizationId`: Tenant ID.
* `userId`: Account ID.
* `roleKey`: Role assigned within this tenant (e.g. `admin`, `developer`).

### 4. [`Role`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/role.contract.js) (`identity.role`)
Defines authority within the system:
* `key`: Unique role identifier (e.g. `operator`, `viewer`).
* `name`: Descriptive name.
* `scope`: `global` (system-wide) or `organization` (tenant-scoped).
* `permissions`: Array of contract patterns permitted for this role (e.g. `["identity.*", "serve.*"]`).
* `inherits`: List of other role keys whose permissions are inherited.

### 5. [`Ticket`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/ticket.contract.js) (`identity.ticket`)
An ephemeral session ticket issued on user login:
* `token`: 64-character hex string (`randomBytes(32)`).
* `userId`: Account ID.
* `expiresAt`: Expiration timestamp (sliding window refreshed on access).

### 6. [`ApiToken`](file:///home/ubuntu/code/mesh-serve/src/identity/contracts/apiToken.contract.js) (`identity.apiToken`)
A persistent token for machine-to-machine integration:
* `tokenHash`: SHA-256 hash of the bearer token string.
* `userId`: Account ID.
* `name`: Descriptive token label.

---

## Cryptographic Implementation

Password and token security is implemented in [`hash.ts`](file:///home/ubuntu/code/mesh-serve/src/identity/methods/hash.ts):

* **Password Hashing**:
  Uses Node's built-in `scrypt` with a 16-byte cryptographically secure random salt and a 64-byte key length (`SCRYPT_KEYLEN = 64`):
  ```ts
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
  ```
* **Password Verification**:
  Derives the hash using the stored salt and compares buffers using `crypto.timingSafeEqual` to prevent timing attacks.
* **Token Security**:
  Bearer tokens are generated via `randomBytes(32).toString('hex')`. Persistent API tokens are stored only as SHA-256 digests (`hashToken`).

---

## Authorization & RBAC

Authorization evaluation is centralized in [`roles.ts`](file:///home/ubuntu/code/mesh-serve/src/identity/methods/roles.ts):

### Effective Role Resolution ([`resolveEffectiveRoleKeys`](file:///home/ubuntu/code/mesh-serve/src/identity/methods/roles.ts#L14))
Combines global and tenant-level roles:
1. **Global Roles**: Direct user roles (`user.roles`) always apply universally.
2. **Membership Roles**: When an `organizationId` is present in the request context, the caller's membership role is resolved.
3. **Privilege Escalation Protection**: A membership role declared with `scope: 'global'` is ignored, preventing organization admins from conferring platform-level global roles to tenant members.

### Permission Matching ([`matchesContract`](file:///home/ubuntu/code/mesh-serve/src/identity/methods/roles.ts#L3))
Permissions support exact contract matching or prefix wildcards:
```ts
export function matchesContract(pattern: string, contract: string): boolean {
    if (pattern === contract) return true;
    return pattern.endsWith('.*') && contract.startsWith(pattern.slice(0, -1));
}
```
* `identity.*` matches `identity.user.register`, `identity.whoami`, etc.
* `serve.*` matches `serve.repo.create`, `serve.cdn.deploy`, etc.

### Contract Tools
* **[`identity.hasRole`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/hasRole.ts#L11)**: Verifies whether a caller holds a specific role key directly or through role inheritance.
* **[`identity.permits`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/permits.ts#L11)**: Checks if any granted role holds a permission pattern matching the target contract.
* **[`identity.whoami`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/whoami.ts#L9)**: Returns the current caller's user record, organizations, and effective permissions.

---

## First-Boot Bootstrapping

During [`IdentityService.onStart`](file:///home/ubuntu/code/mesh-serve/src/identity/identity.service.ts#L89):
1. **Operator Role**: Ensures the `operator` role exists with permissions `["identity.*", "serve.*"]`.
2. **Platform Organization**: Creates the root `platform` organization (slug `platform`) if not present.
3. **Provisional Operator Account**: When no operator exists, generates a provisional account and prints a one-time claim token to the console:
   ```bash
   Claim operator with: mesh-serve login --claim <token>
   ```
