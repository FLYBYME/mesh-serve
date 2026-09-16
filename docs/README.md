# Mesh Serve Documentation

`@flybyme/mesh-serve` is the serving infrastructure of the Mesh platform. It builds repositories into immutable, content-addressed artifacts, manages frontend application compositions, serves web envelopes with strict Content Security Policies via CDN, and exposes dynamic REST API gateways for backend `@flybyme/mesh` service contracts.

---

## Architecture Overview

The system is organized around four core services mounted on a shared [`MeshApp`](file:///home/ubuntu/code/mesh-serve/src/cli/commands/start.ts#L54) broker, alongside an interactive CLI and REPL:

```
                      +-----------------------------+
                      |   Client / Browser / CLI    |
                      +--------------+--------------+
                                     |
              +----------------------+----------------------+
              |                                             |
     [HTTP /assets, HTML]                           [HTTP /api REST]
              |                                             |
              v                                             v
     +-----------------+                           +-----------------+
     |   CdnService    |                           |   ApiService    |
     |   (serve.cdn)   |                           |   (serve.api)   |
     +--------+--------+                           +--------+--------+
              |                                             |
              | calls                                       | calls
              v                                             v
     +-----------------+                           +-----------------+
     | CatalogService  |<==========================| IdentityService |
     | (serve.catalog) |      validates auth       |   (identity)    |
     +-----------------+                           +-----------------+
```

---

## Documentation Sections

1. **[System Architecture](file:///home/ubuntu/code/mesh-serve/docs/architecture.md)**
   Comprehensive conceptual model, service boundaries, data flows, and multi-tenancy design.

2. **[End-to-End Operational Walkthrough](file:///home/ubuntu/code/mesh-serve/docs/walkthrough.md)**
   Full recipe for standing up a new node, claiming operator, compiling parts, composing releases, deploying sites, and calling exposed APIs.

3. **[Catalog Service & Build Engine](file:///home/ubuntu/code/mesh-serve/docs/catalog-service.md)**
   Repositories (`serve.repo`), buildable parts (`serve.part`), esbuild compilation, content-addressed artifacts (`serve.artifact`), composition, and release pinning (`serve.release`).

4. **[CDN Service & Web Envelope](file:///home/ubuntu/code/mesh-serve/docs/cdn-service.md)**
   Sites (`serve.site`), host resolution, HTML envelope generation, import maps, CSP hashing, streaming asset delivery, and maintenance mode.

5. **[API Gateway & Dynamic Dispatch](file:///home/ubuntu/code/mesh-serve/docs/api-service.md)**
   Contract exposure (`serve.expose`), REST routing, parameter matching, role/permission gates, runtime schema introspection (`/_describe`), and typed client generation.

6. **[Identity & Access Control](file:///home/ubuntu/code/mesh-serve/docs/identity-service.md)**
   Accounts (`identity.user`), organizations, memberships, passwords (`scrypt`), tickets (sessions), API tokens, and role-based permissions.

7. **[Contracts & REST API Reference](file:///home/ubuntu/code/mesh-serve/docs/contracts-reference.md)**
   Exhaustive matrix of all `@flybyme/mesh` service contracts, HTTP endpoints, input/output schemas, authorization gates, and system events.

8. **[Configuration & Environment Reference](file:///home/ubuntu/code/mesh-serve/docs/configuration.md)**
   Complete reference for all environment variables, CLI options, local vs. production networking profiles, and filesystem locations.

9. **[CLI & Operations Guide](file:///home/ubuntu/code/mesh-serve/docs/cli-reference.md)**
   Node startup (`mesh-serve start`), interactive REPL, session management, and dynamic CLI commands.
