# API Service & Dynamic Gateway

The [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L59) (`serve.api`) is a dynamic REST gateway that maps `@flybyme/mesh` service contracts to HTTP endpoints with authentication, role/permission authorization gates, runtime schema introspection, and client code generation.

---

## Domain Model & Schemas

### 1. [`Api`](file:///home/ubuntu/code/mesh-serve/src/api/contracts/api.contract.js) (`serve.api`)
Represents an API gateway instance:
* `apiHost`: Hostname where the API is routed (e.g. `api.localhost`, `api.myorg.com`).
* `tenantId`: Organization that owns the API.

### 2. [`Expose`](file:///home/ubuntu/code/mesh-serve/src/api/contracts/expose.contract.js) (`serve.expose`)
Binds an internal mesh contract to the public HTTP surface of an API:
* `apiId`: Reference to the parent `serve.api`.
* `contract`: Full contract key (e.g. `identity.ticket.issue`, `serve.repo.create`). Must refer to a public contract in the global contract registry.
* `role`: Optional coarse role gate (e.g. `operator`, `admin`).
* `permission`: Optional fine-grained permission string (e.g. `catalog.write`).

### 3. [`Want`](file:///home/ubuntu/code/mesh-serve/src/api/contracts/want.contract.js) (`serve.want`)
Tracks contracts demanded by a site's deployed code:
* `siteId`: The site that requires the contract.
* `contract`: The required contract key.
* Reconciled automatically whenever a new release is deployed via [`serve.cdn.deploy`](file:///home/ubuntu/code/mesh-serve/src/cdn/tools/deploy.ts#L17).

---

## Bootstrap API (`api.localhost`)

On startup, [`ensureBootstrapApi`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L91) creates a default API instance on `api.localhost` attached to the `platform` organization to allow initial operator access:

| Contract | Gate | Purpose |
| :--- | :--- | :--- |
| `identity.user.register` | Public | Account creation |
| `identity.ticket.issue` | Public | Authentication / Login |
| `identity.whoami` | Public | Caller identity lookup |
| `identity.user.setPassword` | Public | Password management |
| `serve.expose.add` | `operator` role | Exposing new contracts on APIs |
| `serve.expose.remove` | `operator` role | Un-exposing contracts from APIs |

---

## Request Pipeline

Every inbound HTTP request to `ApiService` passes through a multi-stage pipeline:

```
Incoming Request
       |
       v
1. Resolve Hostname & Target API  -->  Lookup serve.api & serve.expose
       |
       v
2. Route Matching                  -->  Strip /api, matchPath pattern (:param)
       |
       v
3. Authenticate Caller             -->  Validate Bearer token (Ticket / ApiToken)
       |
       v
4. Authorize via Gate              -->  identity.hasRole / identity.permits
       |
       v
5. Parse Input                     -->  Merge query/body with path params
       |
       v
6. Dispatch to Mesh                -->  broker.call(contract, input, { meta })
       |
       v
7. Emit Response                   -->  x-exposure-shape header + JSON payload
```

### 1. Hostname Resolution
The `Host` header is normalized (lowercased, port stripped, IPv6 brackets removed) to locate the corresponding `serve.api` row.

### 2. Route Matching
* All endpoints are prefixed under `/api`.
* Special endpoint `/api/_describe` returns the runtime exposure descriptor.
* Contract routes match against `contract.rest.method` and `contract.rest.path`.
* Dynamic path parameters (e.g. `/sites/:siteId/deploy`) are extracted by [`matchPath`](file:///home/ubuntu/code/mesh-serve/src/api/methods/route.ts#L6).

### 3. Caller Authentication ([`resolveCaller`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L222))
* Parses `Authorization: Bearer <token>`.
* Checks session validity via [`identity.ticket.validate`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/validateTicket.ts#L12).
* If invalid, checks persistent token validity via [`identity.apiToken.validate`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/validateApiToken.ts#L12).
* Unauthenticated requests are treated as anonymous callers.

### 4. Gate Enforcement ([`checkGate`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L282))
* If neither `role` nor `permission` is set on the expose row, the endpoint is public.
* If a gate is present and the caller is anonymous, throws `401 UNAUTHORIZED`.
* **Role Check**: Calls [`identity.hasRole`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/hasRole.ts#L11). Throws `403 FORBIDDEN` if not granted.
* **Permission Check**: Calls [`identity.permits`](file:///home/ubuntu/code/mesh-serve/src/identity/tools/permits.ts#L11). Throws `403 FORBIDDEN` if not permitted.

### 5. Input Parsing & Dispatch
* Merges path parameters with URL query parameters (for `GET`/`DELETE`) or JSON request body (for `POST`/`PUT`/`PATCH`).
* Calls `broker.call(contractKey, input, { meta })` where `meta` injects `tenant_id` and caller `user.id`.
* Emits the response with status 200 and the `x-exposure-shape` descriptor hash header.

---

## Schema Introspection & Client Generation

### Runtime Descriptor (`/api/_describe`)
[`buildDescriptor`](file:///home/ubuntu/code/mesh-serve/src/api/methods/descriptor.ts#L45) joins an API's active `serve.expose` rows against `@flybyme/mesh`'s `globalContractRegistry`:
* Converts contract Zod input/output schemas into JSON Schemas using `zod-to-json-schema`.
* Calculates `shapeHash` (a SHA-256 digest of endpoint paths, methods, inputs, and outputs).
* Calculates `exposure` (a SHA-256 digest of contract keys and authorization gates).

### Client Code Generation ([`generateClient`](file:///home/ubuntu/code/mesh-serve/src/api/methods/generateClient.ts#L54))
Generates self-contained, browser-safe TypeScript code without runtime dependencies on `mesh-serve`:
* Converts JSON schemas back into raw Zod TypeScript source text using `jsonSchemaToZod`.
* Generates typed calls using `@flybyme/mesh-web/net`'s `call<Input, Output>()`.
* Bakes `shapeHash` into the client so the browser runtime can automatically verify API schema parity.
