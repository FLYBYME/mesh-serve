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
| `MESH_METRICS_PORT` | *none* (off) | `start` | Same as `--metricsPort`; the flag wins when both are set. See [Node metrics](#node-metrics-metricsport). |

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
* `--metricsPort <number>`: Serve this node's own metrics at `GET /metrics` on this port, bound to `--host` (the mesh transport's address). Off by default; also read from `MESH_METRICS_PORT`. See below.

### Node metrics (`--metricsPort`)

Since v0.10.8. Prometheus text format (`text/plain; version=0.0.4`), for the fleet's VictoriaMetrics.
Only `GET /metrics` is served; every other path or method is a 404. There is no auth, so the port
listens on `--host` only -- on the fleet that is the node's private address, never `0.0.0.0` unless
`--host` is. A port that is taken, or a `MESH_METRICS_PORT` that is not a port, fails the start
before the node joins anything.

No series carries a node label; the scraper adds `instance`/`node`. Labels are bounded sets only
(action names, topics, outcomes); each metric also caps itself at 1000 label sets and folds the rest
into one series labelled `__overflow__`.

| Metric | Type | Labels | Meaning |
| :--- | :--- | :--- | :--- |
| `mesh_node_info` | gauge | `node_id`, `version`, `mesh_version` | Always 1: which node and which mesh-serve / mesh release. |
| `mesh_rpc_calls_total` | counter | `action`, `outcome` | Calls this node *handled* (local and from the network). `outcome`: `ok`, `error`, `timeout`. `action` is `unknown` for a call to something this node does not serve. |
| `mesh_rpc_duration_seconds` | histogram | `action` | Time to handle those calls, middleware and output validation included. |
| `mesh_rpc_outgoing_total` | counter | `action`, `outcome` | Calls this node *sent* to another node. |
| `mesh_rpc_outgoing_duration_seconds` | histogram | `action` | Their round trip, until the response or the timeout. |
| `mesh_transport_bytes_total` | counter | `direction` (`in`/`out`), `kind` (`request`/`response`/`event`), `topic` | Serialized packet bytes over the WebSocket transport. An RPC's topic is its action name; gossip is `$node.beat`, `$node.presence`, `$node.peers`, ... A broadcast counts once per peer it went to. |
| `mesh_transport_packets_total` | counter | same | Packets, counted the same way. |
| `mesh_event_loop_delay_seconds` | gauge | `stat` (`p50`/`p99`/`max`) | Event loop delay since the previous scrape. |
| `mesh_event_loop_utilization` | gauge | | Fraction of time the event loop was busy since the previous scrape (0-1). |
| `mesh_registry_nodes` | gauge | `available` (`true`/`false`) | Nodes in this node's registry. |
| `process_cpu_seconds_total` | counter | | CPU time of the process. |
| `process_resident_memory_bytes` | gauge | | Resident memory. |
| `nodejs_heap_used_bytes` | gauge | | V8 heap in use. |

The event loop numbers are per scrape window: a second scraper (a `curl` by hand) splits the window
with VictoriaMetrics. Counters and histograms are cumulative and unaffected.

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
