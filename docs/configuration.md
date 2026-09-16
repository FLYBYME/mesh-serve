# Configuration & Environment Reference

This document catalogs every environment variable, command-line argument, and filesystem path used across `@flybyme/mesh-serve`.

---

## Environment Variables

| Variable | Default | Service | Description |
| :--- | :--- | :--- | :--- |
| `SERVER_PORT` | `3123` | [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L108) | The TCP port on which the CDN HTTP server listens for web traffic. |
| `SERVER_HOST` | `::` | [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L109), [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L121) | The network interface to bind HTTP servers to (`::` binds to all IPv6 and IPv4 interfaces via dual-stack). |
| `API_PORT` | `5005` | [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L120) | The TCP port on which the REST API gateway listens. |
| `PUBLIC_SCHEME` | `https` | [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L64) | Scheme embedded in public URLs generated in HTML envelopes (preconnect hints, CSP `connect-src`, and the boot module's `api` address). Must be set to `http` for unproxied local development. |
| `PUBLIC_API_PORT` | *none* | [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L77) | Port appended to public-facing API URLs when running locally without a reverse proxy. Unset in production where the API is reached on the standard port (443/80). |
| `DEFAULT_API_HOST` | `api.localhost` | [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L42) | Hostname assigned to the bootstrap API on first boot. |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | `DatabaseModule` | Connection string for the underlying MongoDB database cluster. |

---

## Node Startup CLI Options (`mesh-serve start`)

The [`StartCommand`](file:///home/ubuntu/code/mesh-serve/src/cli/commands/start.ts#L37) accepts the following flags:

```bash
mesh-serve start [options]
```

* `--nodeID <string>`: Identifier for this mesh node (default: `node-1`).
* `--wsPort <number>`: Mesh peer-to-peer WebSocket transport port (default: `6005`). Unrelated to HTTP ports.
* `--apiPort <number>`: Internal listen port for [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L59) (default: `5005`). Sets `process.env.API_PORT`.
* `--cdnPort <number>`: Internal listen port for [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L95) (default: `3123`). Sets `process.env.SERVER_PORT`.
* `--db <string>`: Target MongoDB database name (e.g. `mesh-production`).
* `--logLevel <enum>`: Log verbosity: `error`, `warn`, `info`, or `debug` (default: `debug`).
* `--publicScheme <enum>`: Public scheme (`http` or `https`). Sets `process.env.PUBLIC_SCHEME`.
* `--publicApiPort <number>`: Public API port for local dev. Sets `process.env.PUBLIC_API_PORT`.

---

## Production vs. Local Development Profiles

### Local Unproxied Development
When testing on a single development machine without Nginx or Caddy:
```bash
mesh-serve start \
  --publicScheme http \
  --publicApiPort 5005 \
  --apiPort 5005 \
  --cdnPort 3123
```
* `PUBLIC_SCHEME=http` ensures WebSocket CSP uses `ws://` and asset preconnect links use `http://`.
* `PUBLIC_API_PORT=5005` ensures the generated boot envelope addresses the API as `http://api.localhost:5005`.

### Production (Behind Reverse Proxy)
When sitting behind a TLS-terminating reverse proxy (Cloudflare, Caddy, AWS ALB):
```bash
mesh-serve start \
  --publicScheme https \
  --apiPort 5005 \
  --cdnPort 3123
```
* `PUBLIC_SCHEME=https` is default; public URLs omit ports because the front door listens on standard 443.
* The reverse proxy forwards `Host` headers to either port `5005` (API subdomains) or port `3123` (frontend sites).

---

## Filesystem Locations

| Path | Purpose |
| :--- | :--- |
| `~/.mesh/artifacts/<hash>/` | Immutable, content-addressed storage for all compiled artifacts. Each directory contains bundled assets (`entry.js`, `style.css`) identified by its SHA-256 content hash. Defined in [`artifacts.ts`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/artifacts.ts#L6). |
| `~/.mesh/session.json` | Local CLI credential cache storing the active `apiHost` and session ticket. Defined in [`store.ts`](file:///home/ubuntu/code/mesh-serve/src/cli/store.ts#L9). |
| `os.tmpdir()/mesh-build-<uuid>` | Ephemeral working directories used during `esbuild` compilation before artifacts are finalized and moved to storage. |
| `~/.mesh/repos/<repo-id>/` | Local Git checkouts managed by [`ensureRepoCheckout`](file:///home/ubuntu/code/mesh-serve/src/catalog/methods/build.ts#L19). |
