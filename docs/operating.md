# Operating a node

**Written for somebody sitting on the machine.** Every command below is run from
an ssh session on the box it affects — there is no orchestration from a laptop,
and nothing here needs one.

Two facts that explain most of the surprises:

- **Configuration is a file, never a command line.** `bin/node.mjs` reads
  `./.env` beside the checkout, or `/etc/mesh/node.env`. A secret typed as an
  argument is visible in `ps` to every user on the box.
- **A part carries the `shapeHash` it was built against.** If the server's shape
  moves and a part is not rebuilt, *every* call that part makes fails with the
  word `stale`. Rebuild all parts together, always.

---

## 1. The configuration file

`/etc/mesh/node.env` (systemd) or `.env` in the checkout (running by hand). Mode
**600**, and `.env` is gitignored.

```ini
MESH_KEY=<the fleet's shared key — identical on every machine>
MONGODB_URI=mongodb+srv://user:pass@cluster/mesh-serve-live?appName=Cluster0
MESH_BLOB_ROOT=/srv/mesh-serve/.artifacts
CDN_PORT=8080
CDN_URL=http://<this machine's public IP>:8080

# Every node except the head:
MESH_BOOTSTRAP=ws://169.197.131.82:4001
```

**⚠ The database name in the URI overrides `--db`.** A URI ending `/test_run?…`
puts you in `test_run` whatever `--db` says, and the symptom is
`No site is configured for this hostname` on a database that visibly has sites in
it. Make the path `mesh-serve-live`.

**Bootstrap is an IP, permanently.** DNS is the product being built; a control
plane that resolves its own head by name cannot reach the machines that would fix
DNS.

Read the fleet's key off any machine already in it:

```bash
grep -oP '(?<=^MESH_KEY=).*' /etc/mesh/node.env
```

---

## 2. Run a node

```bash
cd /srv/mesh-serve
npm run build
node bin/node.mjs --ws 4001 --cdn 8080 --api 5005 --db mesh-serve-live
```

That is the whole command. No variables in front of it — it reads the `.env` and
the banner says which file it used:

```
mesh-serve is up
  mesh      ws://127.0.0.1:4001
  cdn       http://169.197.131.82:8080
  api       http://127.0.0.1:5005
  mongo     mongodb+srv://user:***@cluster/mesh-serve-live
  config    /srv/mesh-serve/.env
```

**Only the head passes `--ws-host 0.0.0.0`.** Every other machine binds loopback
and dials out, so exactly one mesh port is on the internet. Set `MESH_ROLE=head`
in the env, or add the flag.

**⚠ Once a node has a `MESH_KEY`, everything talking to it needs the key** —
including tools on the same box over loopback. `mesh-serve publish` fails with
`Tool "identity.api_token_validate" not found`, which does not look like an auth
error at all. Run CLIs from a directory whose `.env` has the key, or export it.

### Under systemd

```bash
systemctl status mesh-node
systemctl restart mesh-node
journalctl -u mesh-node -f
```

The unit is `deploy/mesh-node.service`. It reads `/etc/mesh/node.env`, restarts
on failure, and caps memory at 600M — a node that dies of OOM and is restarted is
recoverable; one that takes the box down with it is a drive to a datacentre.

---

## 3. Provision a new machine

On the new box, as root:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/FLYBYME/mesh-serve.git /srv/mesh-serve
cd /srv/mesh-serve

install -d -m 700 /etc/mesh
vi /etc/mesh/node.env          # section 1 — MESH_KEY and MONGODB_URI from an existing node

./deploy/provision.sh          # Node 22, npm install, build, systemd unit, start
systemctl status mesh-node
```

`provision.sh` is idempotent — run it again after a change and it converges
rather than duplicating. `MESH_DRY_RUN=1` prints what it would do.

### The fleet

| host | ip | role |
| --- | --- | --- |
| `surf.surfdns.net` | 169.197.131.82 | **head** — the only public mesh port. 981MB, the tightest box |
| `ns1.surfdns.net` | 158.69.203.224 | dial-in |
| `ns2.surfdns.net` | 51.195.151.109 | dial-in |
| `edge1.surfdns.net` | 158.69.213.185 | dial-in |
| `edge2.surfdns.net` | 199.85.8.229 | dial-in — 956MB, 2TB disk |
| `edge3.surfdns.net` | 169.197.131.54 | dial-in |

---

## 4. Local development

**Two checkouts, and they are not the same thing.**

| | | |
| --- | --- | --- |
| `~/code/mesh-serve` | where you edit and run tests | local mongo, no `.env` |
| `~/code/mesh-live` | a node joined to the real fleet | Atlas, real `MESH_KEY`, dials the head |

`mesh-live` is started **exactly the way a VPS starts one** — same command, same
`.env`, no special-casing. If it works there it works on a box, and the local
node stops being a different animal from the live one.

```bash
cd ~/code/mesh-live
git pull && npm run build
node bin/node.mjs --ws 4002 --cdn 8080 --api 5005 --db mesh-serve-live
```

`--ws 4002` so it never fights a local dev node on 4001.

For development against a throwaway database, run from `~/code/mesh-serve` with
no `.env` — it falls back to `mongodb://localhost:27017`. Add
`MESH_ALLOW_REPUBLISH=1` there to overwrite a version in place instead of bumping
for every round trip. **Never on a live node.**

### 4a. From nothing to a hostname that answers — two commands

A fresh node holds an empty database: no operator, no organization, no site. It
answers, and it answers *nothing*. `src/bring-up.ts` is the seed, and it is the
only supported way to get from an empty database to something you can `curl`.

```bash
# terminal one — the cluster, holding the database
npm run node

# terminal two — seed it, through its own contracts
npm run seed
```

`seed` prints the account, the organization, the site and a **ticket**, and then
the `curl` that uses them. That ticket is how you make an authenticated request
without a browser.

**It joins the cluster; it does not write to the database.** An earlier version
mounted `DatabaseModule` and wrote rows directly, which was a second path into
the same collections that skipped every check the contracts exist to enforce —
so what it seeded was not necessarily something the platform would have accepted
from a real caller. Every step is now a contract call, and every step is
idempotent: running it twice is how you find out that it is.

What it takes, when the defaults are wrong:

| flag | default | |
| --- | --- | --- |
| `--email` `--password` `--name` | `tim@example.com` … | the operator account |
| `--org-slug` `--org-name` | — | **name it.** It once defaulted, and against a cluster that already had one it created a second and moved the account into it — so with none it now stops and asks |
| `--host` | `localhost` | the hostname the site answers on |
| `--api` | `http://127.0.0.1:5005` | where that site's api is |
| `--bootstrap` | the node's own ws port | a cluster somewhere else |

Secrets are never flags. `MESH_KEY` comes from `.env`, because a value typed as
`MESH_KEY=… npx tsx …` is visible in `ps` to every user on the machine and lands
in your shell history.

---

## 5. Publish and deploy

Four steps on purpose: publishing says *this version exists*; building produces
bytes; composing pins a set; deploying points a hostname at it.

```bash
cd ~/code/mesh-core            # the repository whose mesh.json changed
git add -A && git commit && git push          # ⚠ the builder clones from GitHub
MESH_TOKEN=<token> node ~/code/mesh-serve/bin/mesh-serve.mjs publish --publisher flybyme
```

**⚠ Push before publishing.** An unpushed commit fails with *"the repository was
reachable, so this is not a credential problem — the commit is missing."*

**⚠ Bump every part that talks to the API together** — `catalog`, `releases`,
`auth`, `fleet`, `sites`. `chrome` and `ui` do not call the API. Miss one and
that one part fails every call with `stale`.

Building, composing and deploying have no CLI yet; they are contract calls.

---

## 6. Fleet operations

All from the **Fleet console**, which is the intended interface. The same calls
exist over the API, gated `operator`:

| call | what it does |
| --- | --- |
| `node.status` | what each machine is running and what it can see |
| `node.assign` | set desired services and/or groups; reconciles live |
| `node.reconcile` | make running match desired — idempotent, safe twice |
| `node.provision` | clone a repo at a **pinned ref**, install, register it |

`node.assign` is a **switch**: it starts and stops services inside the running
process, never restarting it. systemd owns the process; the Supervisor owns
services inside it.

**Core services are not switchable** — `api`, `identity`, `fleet`, `supervisor`
run because the node runs. A machine that could be told to switch off the service
receiving its orders could never be told anything again.

Groups (`serve`, `edge`, `build`) are stored **by name, not expanded**, so
editing a group rolls onto every machine in it.

---

## 7. When something is wrong

| symptom | cause |
| --- | --- |
| every call from one part says `stale` | that part was not rebuilt after the server's shape moved |
| `No site is configured for this hostname` | wrong database — check the URI's **path**, not just `--db` |
| `Tool "…" not found` from a CLI | `MESH_KEY` missing from the CLI's environment |
| a console window never appears | an Application opens its own window; declaring `views` does not |
| `Unknown service: api` from assign | a core service was assigned; they are not switchable |
| a node starts services it was not assigned | it was told nothing and fell back to starting everything |
| publish says the commit is missing | commit and **push** first |
| browser tests hang forever | needs `--no-file-parallelism` |

`ctrl+alt+q` in any console opens the log viewer — every `cx.log.*` from every
part plus the kernel's own warnings, filterable by level and source.
