# Operating the platform

Every command you need, in the order you would actually need them. Written
2026-09-07, from doing each one by hand at least once — the notes marked **⚠**
are mistakes that cost real time, not hypotheticals.

Two facts that explain most of the surprises below:

- **A part carries the `shapeHash` it was built against.** If the server's shape
  moves and a part is not rebuilt, *every* call that part makes fails with the
  word `stale`. Rebuild all parts together, always.
- **The node is the only way in.** There is no admin CLI that reaches past it.
  Publishing, building, composing and deploying are all contract calls to a
  running node.

---

## 0. The two secrets

| variable | what it is | where it lives |
| --- | --- | --- |
| `MESH_KEY` | the shared key a peer presents at the WebSocket handshake | `/etc/mesh/node.env` on every node |
| `MESH_TOKEN` | an API token identifying **you** when publishing | your shell, not a file |

**Every node in the fleet must have the same `MESH_KEY`.** It is generated once
and copied; there is no negotiation.

Read the current one off the head:

```bash
ssh -i ~/.ssh/paas_infra_ed25519 root@169.197.131.82 \
  'grep -oP "(?<=^MESH_KEY=).*" /etc/mesh/node.env'
```

**⚠ Once a node has a key, everything talking to it needs the key — including
tools on the same machine over loopback.** `mesh-serve publish` fails with
`Tool "identity.api_token_validate" not found` if you forget, which does not
look like an auth error at all.

---

## 1. Run a node locally

```bash
cd ~/code/mesh-serve
npm run build

MESH_KEY=<the key> \
MONGODB_URI='mongodb+srv://…/mesh-serve-live?…' \
node bin/node.mjs --ws 4002 --cdn 8080 --api 5005 \
                  --db mesh-serve-live \
                  --bootstrap ws://169.197.131.82:4001
```

- `--ws 4002` — this laptop uses 4002 so it never fights the head's 4001.
- `--bootstrap` — dial the head. Omit it to run alone.
- **No `--ws-host`.** Loopback is the default and correct for every node except
  the head.

**⚠ The database name in the URI overrides `--db`.** A URI ending `/test_run?…`
puts you in `test_run` no matter what `--db` says, and the symptom is
`No site is configured for this hostname` on a database that visibly has sites
in it. Make the URI path `mesh-serve-live`.

Add `MESH_ALLOW_REPUBLISH=1` while developing to overwrite a version in place
instead of bumping for every round trip. **Never set it on a production node.**

---

## 2. Publish, build, deploy

Four separate steps on purpose. Publishing says *this version exists*; building
produces bytes; composing pins a set; deploying points a hostname at it.

### Publish

From the repository whose `mesh.json` you changed:

```bash
cd ~/code/mesh-core          # or mesh-web
MESH_KEY=<key> MESH_TOKEN=<token> MESH_BOOTSTRAP=ws://127.0.0.1:4002 \
  node ~/code/mesh-serve/bin/mesh-serve.mjs publish --publisher flybyme
```

**⚠ Commit and push first.** Publishing records the current commit and the
builder clones it from GitHub — an unpushed commit fails with *"the repository
was reachable, so this is not a credential problem — the commit is missing."*

### Build, compose, deploy

There is no CLI for these yet; they are contract calls. The working script is
`scratch/ship.mjs` in the pattern below — build every part, compose, deploy:

```js
await app.call('builder.build_start', { part, version }, { meta, timeout: 600000 });
const composed = await app.call('cdn.compose', { kernel: '^0.15', name, parts }, { meta });
await app.call('cdn.deploy', { host: 'console.localhost', release: composed.hash }, { meta });
```

`meta` comes from validating your token:

```js
const v = await app.call('identity.api_token_validate', { token: process.env.MESH_TOKEN });
const meta = { user: { id: v.userId, tenant_id: v.organizationId, roles: v.roles },
               tenant_id: v.organizationId };
```

**⚠ Bump and rebuild every part that talks to the API together** — `catalog`,
`releases`, `auth`, `fleet`, `sites`. `chrome` and `ui` do not call the API and
can stay. Miss one and that one part fails every call with `stale`.

---

## 3. Add a machine to the fleet

```bash
# From your laptop. The env file is piped over stdin — never on a command line,
# where every user on the box can read it out of `ps`.
{ printf 'MESH_KEY=%s\n' "$(ssh -i ~/.ssh/paas_infra_ed25519 root@169.197.131.82 \
      'grep -oP "(?<=^MESH_KEY=).*" /etc/mesh/node.env')"
  printf 'MONGODB_URI=%s\n' 'mongodb+srv://…/mesh-serve-live?…'
  printf 'MESH_BLOB_ROOT=/srv/mesh-serve/.artifacts\nCDN_PORT=8080\n'
  printf 'CDN_URL=http://<this box IP>:8080\nNODE_OPTIONS=--max-old-space-size=420\n'
} | ssh -i ~/.ssh/paas_infra_ed25519 root@<IP> \
    'bash -s' < ~/code/mesh-serve/deploy/provision.sh
```

`provision.sh` is idempotent — running it again converges rather than
duplicating. Useful variables:

| variable | effect |
| --- | --- |
| `MESH_REF` | branch, tag or commit to check out (default `master`) |
| `MESH_ROLE` | `head` opens the mesh port; `dialin` binds loopback. Default: `surf` → head, everything else → dialin |
| `MESH_DRY_RUN=1` | print what it would do |

**Only `surf` is a head.** Every other machine binds loopback and dials out, so
exactly one mesh port is on the internet.

### The fleet

| host | ip | note |
| --- | --- | --- |
| `surf.surfdns.net` | 169.197.131.82 | **head**, 981MB — the tightest box |
| `ns1.surfdns.net` | 158.69.203.224 | |
| `ns2.surfdns.net` | 51.195.151.109 | |
| `edge1.surfdns.net` | 158.69.213.185 | |
| `edge2.surfdns.net` | 199.85.8.229 | 956MB, 2TB disk |
| `edge3.surfdns.net` | 169.197.131.54 | |

**Bootstrap is an IP, permanently.** DNS is the product being built; a control
plane that resolves its own head by name cannot reach the machines that would
fix DNS.

---

## 4. Fleet operations

On a node: `systemctl status|restart|stop mesh-node`, and
`journalctl -u mesh-node -f` to watch it.

Everything else is the Fleet console, or these calls (all gated `operator`):

| call | what it does |
| --- | --- |
| `node.status` | what a machine is running and what it can see |
| `node.assign` | set desired services and/or groups; reconciles live |
| `node.reconcile` | make running match desired — idempotent, safe twice |
| `node.provision` | clone a repo at a **pinned ref**, install, register it as a service |

`node.assign` is a **switch**: it starts and stops services inside the running
process, never restarting it. systemd owns the process; the Supervisor owns
services inside it. Two supervisors, one boundary.

**Core services are not switchable**: `api`, `identity`, `fleet`, `supervisor`
run because the node runs. A machine that could be told to switch off the
service receiving its orders could never be told anything again.

Groups (`serve`, `edge`, `build`) are stored **by name, not expanded** — editing
a group rolls onto every machine in it.

---

## 5. Move a database to Atlas

```bash
SOURCE_URI=mongodb://localhost:27017 \
TARGET_URI='mongodb+srv://…' \
node scripts/migrate-to-atlas.mjs            # dry run, writes nothing
node scripts/migrate-to-atlas.mjs --commit   # for real
```

Copies, never moves — the source is left as it was and stays a working fallback.
Idempotent by `_id`, so a second run converges instead of failing on duplicates.

---

## 6. When something is wrong

| symptom | cause |
| --- | --- |
| every call from one part says `stale` | that part was not rebuilt after the server's shape moved |
| `No site is configured for this hostname` | wrong database — check the URI's path, not just `--db` |
| `Tool "…" not found` from a CLI | `MESH_KEY` missing from the CLI's environment |
| a console window never appears | an Application opens its own window; declaring `views` does not do it |
| `Unknown service: api` from assign | a core service was assigned; they are not switchable |
| the browser test suite hangs forever | needs `--no-file-parallelism`; six parallel browsers deadlock |
| publish says the commit is missing | commit and **push** before publishing |

`ctrl+alt+q` in any console opens the log viewer — every `cx.log.*` from every
part plus the kernel's own warnings, filterable by level and source.
