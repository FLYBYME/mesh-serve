# Contracts & REST API Reference

This document provides a comprehensive specification of every `@flybyme/mesh` contract, REST endpoint, and event defined across the four core services.

---

## 1. Catalog Service Contracts (`serve.*`)

### `serve.artifact.requestBuild`
* **Action**: `requestBuild`
* **REST**: `POST /artifacts/requestBuild`
* **Gate**: Public (restricted by caller tenant context)
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    partId: string;           // ID of the serve.part to build
    ref: string;              // Git commit SHA, branch, or tag
    drivers?: string[];       // Driver keys to bake in (only valid when part is kind: kernel)
  }
  ```
* **Output**: Returns the newly created `serve.artifact` record with `status: 'pending'`.

### `serve.artifact.getArtifact`
* **Action**: `getArtifact`
* **REST**: `GET /artifacts/:hash`
* **Gate**: Public
* **Input**: `{ hash: string }`
* **Output**: The full `serve.artifact` document including status, asset manifest, and build duration.

### `serve.artifact.getAsset`
* **Action**: `getAsset`
* **REST**: `GET /artifacts/:artifactHash/assets/:path`
* **Gate**: Public
* **Input**: `{ artifactHash: string, path: string }`
* **Output**:
  ```ts
  {
    name: string;             // File basename
    path: string;             // Relative path in artifact
    contentType: string;      // MIME type (e.g. text/javascript; charset=utf-8)
    contentLength: number;    // Size in bytes
    lastModified: string;     // UTC string
    eTag?: string;            // SHA-1 hash with double quotes
    fileExtension?: string;   // e.g. ".js"
    size?: number;            // Size in bytes
  }
  ```

### `serve.composition.compose`
* **Action**: `compose`
* **REST**: `POST /compositions/:id/compose`
* **Gate**: Public
* **Destructive**: Yes
* **Input**: `{ id: string }` (Composition ID)
* **Output**:
  ```ts
  {
    id: string;
    tenantId: string;
    compositionId: string;
    hash: string;             // SHA-256 release hash
    parts: Array<{
      partKey: string;
      kind: 'kernel' | 'application' | 'extension' | 'driver' | 'theme';
      artifactHash: string;
      imports?: string;
    }>;
  }
  ```

### `serve.release.getRelease`
* **Action**: `getRelease`
* **REST**: `GET /releases/:hash`
* **Gate**: Public
* **Input**: `{ hash: string }`
* **Output**: The resolved `serve.release` document.

---

## 2. CDN Service Contracts (`serve.cdn`)

### `serve.cdn.resolveHost`
* **Action**: `resolveHost`
* **REST**: `GET /sites/:host`
* **Gate**: Public
* **Input**: `{ host: string }` (Normalized hostname)
* **Output**: The matching `serve.site` record.

### `serve.cdn.resolveById`
* **Action**: `resolveById`
* **REST**: `GET /sites/id/:id`
* **Gate**: Public
* **Input**: `{ id: string }`
* **Output**: The matching `serve.site` record.

### `serve.cdn.deploy`
* **Action**: `deploy`
* **REST**: `POST /sites/:siteId/deploy`
* **Gate**: Public (tenant-isolated)
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    siteId: string;           // Target site ID
    releaseHash: string;      // Release hash to serve
  }
  ```
* **Output**:
  ```ts
  {
    site: Site;               // Updated site record with releaseHash set
    wantsAdded: string[];     // Contracts added to serve.want
    wantsRemoved: string[];   // Contracts removed from serve.want
  }
  ```

---

## 3. API Gateway Contracts (`serve.api`)

### `serve.api.resolveByHost`
* **Action**: `resolveByHost`
* **REST**: `GET /apis/:apiHost`
* **Gate**: Public
* **Input**: `{ apiHost: string }`
* **Output**: The `serve.api` document.

### `serve.api.resolveById`
* **Action**: `resolveById`
* **REST**: `GET /apis/id/:id`
* **Gate**: Public
* **Input**: `{ id: string }`
* **Output**: The `serve.api` document.

### `serve.expose.add`
* **Action**: `add`
* **REST**: `POST /expose`
* **Gate**: Configurable (defaults to `operator` role on bootstrap API)
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    apiId: string;            // Target API ID
    contract: string;         // Public contract key (e.g. "identity.whoami")
    role?: string;            // Coarse role gate
    permission?: string;      // Fine-grained permission pattern gate
  }
  ```
* **Output**: The created `serve.expose` document.

### `serve.expose.remove`
* **Action**: `remove`
* **REST**: `POST /expose/remove`
* **Gate**: Configurable (defaults to `operator` role on bootstrap API)
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    apiId: string;
    contract: string;
  }
  ```
* **Output**: `{ removed: true }`

### `serve.api.generateClient`
* **Action**: `generateClient`
* **REST**: `POST /generate-client`
* **Gate**: Public
* **Input**:
  ```ts
  {
    apiId: string;
    contracts?: string[];     // Optional subset of contract keys to render
  }
  ```
* **Output**: `{ source: string }` (TypeScript source code)

---

## 4. Identity Contracts (`identity.*`)

### `identity.user.register`
* **Action**: `register`
* **REST**: `POST /identity/register`
* **Gate**: Public
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    email: string;            // Valid email address
    password: string;         // Minimum 8 characters
    displayName: string;      // Human name
  }
  ```
* **Output**: `{ userId: string }`

### `identity.ticket.issue`
* **Action**: `issue`
* **REST**: `POST /identity/ticket`
* **Gate**: Public
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    email: string;
    password: string;
    via?: string;             // Audit log context
  }
  ```
* **Output**:
  ```ts
  {
    token: string;            // 64-char hex bearer ticket
    userId: string;
    expiresAt: number;        // Epoch millisecond timestamp
  }
  ```

### `identity.ticket.validate`
* **Action**: `validate`
* **REST**: `POST /identity/ticket/validate`
* **Gate**: Public
* **Input**: `{ token: string }`
* **Output**:
  ```ts
  {
    valid: boolean;
    userId?: string;
    roles?: string[];
  }
  ```

### `identity.ticket.revoke`
* **Action**: `revoke`
* **REST**: `POST /identity/ticket/revoke`
* **Gate**: Public
* **Destructive**: Yes
* **Input**: `{ token?: string, userId?: string, reason?: string }`
* **Output**: `{ revoked: number, epoch: number }`

### `identity.ticket.signOut`
* **Action**: `signOut`
* **REST**: `POST /identity/ticket/signout`
* **Gate**: Public
* **Destructive**: Yes
* **Input**: `{}` (Ticket extracted from `Authorization: Bearer <token>`)
* **Output**: `{ ok: true }`

### `identity.apiToken.issue`
* **Action**: `issue`
* **REST**: `POST /identity/apiToken`
* **Gate**: Public (reads caller from context)
* **Destructive**: Yes
* **Input**: `{ name: string }`
* **Output**: `{ id: string, token: string, name: string }` (Token string emitted only once)

### `identity.apiToken.validate`
* **Action**: `validate`
* **REST**: `POST /identity/apiToken/validate`
* **Gate**: Public
* **Input**: `{ token: string }`
* **Output**: `{ valid: boolean, userId?: string }`

### `identity.whoami`
* **Action**: `whoami`
* **REST**: `GET /identity/whoami`
* **Gate**: Public (reads caller from context)
* **Input**: `{}`
* **Output**:
  ```ts
  {
    userId: string;
    email: string;
    displayName: string;
    roles: string[];          // Cluster-scoped roles
    organizations: Array<{
      organizationId: string;
      name: string;
      roleKey: string;        // Role in this organization
    }>;
  }
  ```

### `identity.user.setPassword`
* **Action**: `setPassword`
* **REST**: `POST /identity/password`
* **Gate**: Public (reads caller from context)
* **Destructive**: Yes
* **Input**: `{ password: string }` (Minimum 12 characters)
* **Output**: `{ ok: true, claimed: boolean }`

### `identity.user.grantRole`
* **Action**: `grantRole`
* **REST**: `POST /identity/roles`
* **Gate**: Public
* **Destructive**: Yes
* **Input**:
  ```ts
  {
    userId?: string;
    email?: string;
    role: string;             // Cluster role key (e.g. "operator")
    granted?: boolean;        // true to grant, false to revoke
  }
  ```
* **Output**: `{ userId: string, roles: string[], changed: boolean }`

### `identity.hasRole`
* **Action**: `hasRole`
* **REST**: `POST /identity/hasRole`
* **Gate**: Public
* **Input**:
  ```ts
  {
    userId: string;
    role: string;
    organizationId?: string;
  }
  ```
* **Output**: `{ granted: boolean }`

### `identity.permits`
* **Action**: `permits`
* **REST**: `POST /identity/permits`
* **Gate**: Public
* **Input**:
  ```ts
  {
    userId: string;
    contract: string;
    organizationId?: string;
  }
  ```
* **Output**: `{ permitted: boolean }`

---

## 5. System Events

| Event Name | Payload Schema | Scoped By | Triggered When |
| :--- | :--- | :--- | :--- |
| `serve.artifact.built` | `{ tenantId, artifact, hash, assets }` | `tenantId` | Artifact compilation succeeds in [`CatalogService`](file:///home/ubuntu/code/mesh-serve/src/catalog/catalog.service.ts#L191). |
| `serve.artifact.buildFailed` | `{ tenantId, artifact, error }` | `tenantId` | Artifact compilation throws an error. |
| `identity.ticket.revoked` | `{ id, userId, tokenId, revokedAt, revokedReason }` | `userId` | A session ticket is revoked. |
| `identity.user.signed_out` | `{ userId }` | `userId` | An account signs out of an active session. |
