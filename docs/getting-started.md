# Getting started: a local node, claimed, and the CLI

Checked against the code on 2026-10-12 (`src/cli/commands/*`, `src/cli/core/*`). If something here
stops matching the code, trust the code. Replaces `walkthrough.md` and `cli-reference.md`, which
described a `login --claim <token>` flow that does not exist.

Run every command below from `~/code/mesh/mesh-serve` as `node bin/mesh-serve.mjs ...` (or
`npx mesh-serve ...` where it is installed as a dependency).

## 1. A database

mesh reads `MONGODB_URI` and falls back to `mongodb://localhost:27017`. For local work:

```sh
docker run -d --name mesh-mongo -p 127.0.0.1:27017:27017 mongo:7
```

## 2. Start a node

```sh
node bin/mesh-serve.mjs start --nodeID dev --db mesh-dev --publicScheme http --publicApiPort 5005
```

| option | default | what it is |
|---|---|---|
| `--nodeID` | `node-1` | this node's name in the mesh |
| `--db` | | the database **name** (not a connection string: that is `MONGODB_URI`). A new name is a new, unclaimed node |
| `--host` | `127.0.0.1` | where the mesh transport listens. Anything but loopback needs `--sharedKey` |
| `--wsPort` | `6005` | mesh transport |
| `--apiPort` | `5005` | the api (REST + SSE) |
| `--cdnPort` | `3123` | the site server |
| `--sharedKey` | `MESH_KEY` | the secret every node joining this mesh must present |
| `--publicScheme` | `https` | the scheme put into pages' api URLs: `http` for an unproxied local node |
| `--publicApiPort` | | the port put into those URLs: `5005` locally, unset behind a proxy |
| `--bootstrapNode` | | `ws://` URL(s) of nodes to join; omit for a cluster of one |
| `--parts` | | core parts this node must run even if nothing calls them (`api`, `cdn`, timers) |
| `--labels` | | `key=value` labels a part's `nodeSelector` matches |

A fresh node runs only the catalog. Identity, the api and the rest are loaded by claiming it.

## 3. Claim it -- once

In a second terminal, while the node runs:

```sh
node bin/mesh-serve.mjs bootstrap
```

It asks for your name, email, a password (12 characters at least) and an organization name. Without
the questions (scripts, CI) -- the password only ever from the environment, never a flag:

```sh
MESH_BOOTSTRAP_PASSWORD='...' node bin/mesh-serve.mjs bootstrap --name "Your Name" --email you@example.com
```

Claiming connects to the node over the mesh itself (there is no api to go through yet) and:

1. loads the core parts (identity, api, cdn, ...) on the node,
2. seeds the built-in roles,
3. creates **your account**, role `operator`,
4. creates the **`platform` organization**, owned by you,
5. creates the **bootstrap api** at `api.localhost` (`--apiHost` to change it).

There is no second claim and no reset: run again, it answers "Already claimed". To start over, use
a new `--db` name, or drop the database and restart the node.

Options: `--bootstrapNode` (default `ws://127.0.0.1:6005`), `--sharedKey` (or `MESH_KEY`),
`--orgName` (default `Platform`), `--apiHost`.

## 4. Sign in

```sh
node bin/mesh-serve.mjs login --api http://api.localhost:5005 --email you@example.com
node bin/mesh-serve.mjs identity.whoami
```

The password is asked for, or read from `MESH_PASSWORD`. `*.localhost` resolves to 127.0.0.1 on most
systems; if `api.localhost` does not, add `127.0.0.1 api.localhost` to `/etc/hosts`.

**The CLI keeps one session**, in `~/.mesh-serve/session.json`: the api it talks to, your ticket,
and that api's command list. Signing in to a local node replaces a session you had with another
api. To keep both, give one of them its own home: `HOME=~/.mesh-dev-home node bin/mesh-serve.mjs ...`.

## 5. The CLI

Two kinds of command.

**Its own**, always there:

| command | does |
|---|---|
| `start` | runs a node (section 2) |
| `bootstrap` | claims a fresh node (section 3) |
| `login` | `--api <origin> --email <address>`: signs in, keeps the ticket |
| `logout` | ends the ticket at the api and forgets it |
| `switch [url]` | points the CLI at an api (no url: says where it points) and reads its commands again |
| `apis` | lists every api your account can switch to |
| `generate` | `--host <api host>` or `--api <id>`, `--out <file>`: writes that api's typed client |
| `watch [events...]` | streams the api's events (all it exposes, or those named); `--json` for raw lines |
| `sync` | `--site <spec>`: applies a site spec through the api; `--out` for its client, `--force` to rebuild |
| `artifact-build` | `--repo --ref --kind --entry --out`: builds a part here, with this release's builder |
| `artifact-import <dir>` | `--partId <id> [--pin]`: brings that build in as a successful build of the part |

**One per contract the api exposes to you**, named `domain.action` -- `identity.whoami`,
`serve.part.find`, `serve.expose.add`, ... They are read from the api's `/api/_describe` at sign-in
and kept in the session (so `--help` works offline). Each takes its input as flags, or whole:

```sh
node bin/mesh-serve.mjs serve.part.find --json '{"query":{"key":"platform/registry"}}'
echo '{"name":"x","secret":"..."}' | node bin/mesh-serve.mjs vaultSecret.seal --json -   # a secret: stdin, never the command line
```

A contract you cannot see is not exposed on this api, or not to your role. An operator exposes one:

```sh
node bin/mesh-serve.mjs serve.api.find                      # the api's id
node bin/mesh-serve.mjs serve.expose.add --json '{"apiId":"<id>","contract":"<domain.action>","role":"operator"}'
node bin/mesh-serve.mjs login --email you@example.com       # sign in again to learn it
```

A part just deployed takes a few seconds to serve its contracts: exposing one before then is refused
("No node serves ... (yet)").

## 6. A mesh-web site against the local node

The company site's dev server (`surfdns-company-site`):

```sh
VITE_API=http://api.localhost:5005 npm run dev     # http://localhost:5190
```

Without `VITE_API` the site reaches no api at all. A bare local node has identity, so signing in
works; pages that call other parts' contracts need those parts deployed on the node and their
contracts exposed (section 5).
