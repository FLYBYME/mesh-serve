# CLI & Operational Reference

The `mesh-serve` command-line interface provides operational commands for starting a mesh node, managing sessions, generating clients, and dynamically invoking exposed service contracts.

---

## Invocation Modes

The binary (`bin/mesh-serve.mjs`) supports two modes:

### 1. Interactive REPL Mode
Running `mesh-serve` without arguments launches an interactive read-eval-print loop with command history and prompt auto-completion:
```bash
$ mesh-serve
mesh-serve (localhost:5005)> help
```

### 2. Direct Command Mode
Running `mesh-serve <command> [args...]` executes a single command and returns:
```bash
$ mesh-serve start --apiPort 5005 --cdnPort 3123
```

---

## Built-In Commands

### `mesh-serve start`
Boots a complete Mesh node mounting all four core services:
* `--nodeID <string>`: Node identifier (default: `node-1`).
* `--wsPort <number>`: Mesh WebSocket peer transport port (default: `6005`).
* `--apiPort <number>`: [`ApiService`](file:///home/ubuntu/code/mesh-serve/src/api/api.service.ts#L59) REST+SSE listen port (default: `5005`).
* `--cdnPort <number>`: [`CdnService`](file:///home/ubuntu/code/mesh-serve/src/cdn/cdn.service.ts#L95) frontend listen port (default: `3123`).
* `--db <string>`: MongoDB database name (default: derived from connection string).
* `--logLevel <enum>`: Logger severity (`error`, `warn`, `info`, `debug`, default: `debug`).
* `--publicScheme <enum>`: Public URL scheme embedded in HTML envelopes (`http` or `https`, default: `https`).
* `--publicApiPort <number>`: Public-facing port for API URLs in local unproxied deployments.

### `mesh-serve login`
Authenticates with the active API host and saves the session ticket to `~/.mesh/session.json`:
* Username and password authentication:
  ```bash
  mesh-serve login --username <user> --password <pass>
  ```
* Claiming a first-boot provisional operator account:
  ```bash
  mesh-serve login --claim <one-time-claim-token>
  ```

### `mesh-serve logout`
Revokes the active ticket and clears credentials from the local session store.

### `mesh-serve switch`
Switches the active API host endpoint:
```bash
mesh-serve switch <apiHost>
```

### `mesh-serve refresh`
Refreshes the active session ticket and re-fetches exposed API contracts from the host.

### `mesh-serve generate`
Fetches the live API exposure from `/_describe` and renders a typed, self-contained TypeScript/Zod client:
```bash
mesh-serve generate --out <path-to-client.ts>
```

---

## Dynamic Contract Dispatch

Whenever `mesh-serve` connects to an API host, it fetches the active exposure descriptor from `/api/_describe` via [`attachDynamicCommands`](file:///home/ubuntu/code/mesh-serve/src/cli/dynamic.ts#L10). 

Every exposed contract is automatically mounted as a Commander subcommand grouped under its domain:
```bash
# Invoking tools dynamically over REST
mesh-serve identity whoami
mesh-serve serve.repo create --url "https://github.com/..." --defaultBranch "main"
mesh-serve serve.artifact requestBuild --partId "<part-id>" --ref "HEAD"
mesh-serve serve.cdn deploy --siteId "<site-id>" --releaseHash "<hash>"
```

Subcommand option flags and validation rules are derived directly from the contract's Zod input schema.
