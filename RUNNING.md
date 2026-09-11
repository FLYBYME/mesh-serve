# Running a cluster, and seeding the two sites

**Every command here was run on 2026-09-11 and its output is what is shown.** Nothing is
transcribed from memory, because the two mistakes this file exists to prevent are both mistakes
about a flag name, and a flag name is exactly what a person remembers wrong.

One rule underneath all of it: **everything mesh-serve provides is reachable through its API and its
CLI, and through nothing else.** There is no script that opens the database. `seed` below is an
ordinary authenticated HTTP call to `site.seed`, which is why a browser can do the same thing.

## The cluster is already seeded — just start the node

This is the usual case. The database holds the accounts, the organizations, the sites and every
release, so **nothing needs reseeding**. One command, and it stays in the foreground.

```bash
cd ~/code/mesh-serve
node bin/mesh-serve.mjs node \
  --ws 4001 --cdn 8080 --api 5005 --mcp 5006 \
  --db surfdns-stage3 \
  --service /home/ubuntu/code/flowboard/dist/index.js
```

It prints its endpoints and then `Ctrl-C to stop.` Both sites answer immediately:

- `http://console.localhost:8080/`
- `http://flowboard.localhost:8080/`

**`--service` is flowboard's server half**, and it is a path into that repository's `dist`, so
`npm run build:server` in `~/code/flowboard` has to have run at least once. The console has no
server half — it is a browser application over contracts mesh-serve already provides.

**If the node exits immediately, check for `EADDRINUSE` before anything else.** An older node
holding 4001 has cost hours twice: the new one dies, the old one keeps serving a *stale* control
site, and every symptom points at the code you just changed. `pgrep -af mesh-serve.mjs` lists them
all — kill all of them, not the first one.

### Accounts on `surfdns-stage3`

| account | password | what it is |
| --- | --- | --- |
| `operator@node.invalid` | `flowboard-dev-0910` | the first-boot operator, in Platform |
| `tenant@flowboard.test` | `tenant-pass-0910` | owns Flowboard Inc |
| `stranger@nowhere.test` | `stranger-pass-0910` | in no organization — the refusal case |

The stranger is not clutter. Half of what the platform promises is what a caller *cannot* see, and
an account in no organization is the only way to check it without creating one each time.

## From nothing — a fresh database

Two steps, and the first one prints a password exactly once.

### 1. The node

```bash
cd ~/code/mesh-serve
node bin/mesh-serve.mjs node \
  --ws 4001 --cdn 8080 --api 5005 --mcp 5006 \
  --db <a new name> \
  --service /home/ubuntu/code/flowboard/dist/index.js
```

On an empty database it prints, once:

```
  FIRST BOOT — no accounts existed, so one was created.

    email     operator@node.invalid
    password  _J6nexYW2EqXszTLUFmL-8uN0z6jcgWq

  This is shown once and is not recoverable. It can do nothing except set its own
  password — every other call is refused until it does.
```

That account is **provisional**: refused everywhere above `public` until somebody sets a password of
their own, which is what `--set-password` below does. Nothing works until you do, which is the
point — *"you should change this" does not survive a busy week.*

### 2. Seed the two sites

In a second terminal. **`--control` is the flag that names the node**, not `--api`. `--api` exists
and means something else — the API URL the *page* will call — so passing it here signs in against
the default `http://127.0.0.1:5005` and fails with *Those credentials are not valid* while a node is
plainly running in front of you. That is the first mistake this file exists to prevent.

```bash
# console.localhost — the platform's own console, owned by Platform
node bin/mesh-serve.mjs seed \
  --control http://127.0.0.1:5005 \
  --password '<the printed one>' --set-password '<your own, 12+ characters>' \
  --host console.localhost \
  --org-slug platform --org-name Platform \
  --repo /home/ubuntu/code/.git-remotes/mesh-web.git \
  --repo /home/ubuntu/code/.git-remotes/mesh-core.git \
  --repo /home/ubuntu/code/.git-remotes/mesh-operator.git \
  --parts console,auth,ui
```

```
[identity] account claimed — the printed password no longer works
[identity] signed in to http://127.0.0.1:5005 as operator@node.invalid
[seed] console.localhost ← 3 repositor(y|ies)
[seed]   kernel mesh-web@0.16.5
[seed]   extension auth@0.1.0
[seed]   application identity@0.1.0
[seed]   extension ui@0.1.0
[seed]   application console@0.1.0

[seed] console.localhost → sha256:d42f387719486f60c3e5b70e5e339fb2
```

```bash
# flowboard.localhost — a tenant, owned by a different organization
node bin/mesh-serve.mjs seed \
  --control http://127.0.0.1:5005 \
  --password '<the one you just set>' \
  --host flowboard.localhost \
  --org-slug fb --org-name "Flowboard Inc" \
  --repo /home/ubuntu/code/.git-remotes/flowboard.git \
  --parts flowboard,auth,ui,flowboard-agent
```

**Note what the second command does not pass.** It imports only `flowboard.git`, and names `auth`
and `ui` among its parts anyway. Passing `--repo .../mesh-core.git` a second time is refused:

```
"mesh-web" is already published by another organization, and a part name is one global
namespace — so importing … cannot claim it. If you meant to use their copy, do not import
this repository: name "mesh-web" among the parts to compose and the catalog resolves it
across publishers.
```

That is the second mistake this file exists to prevent, and the message is the way out: **a part
name is one global namespace and a part belongs to its publisher.** Importing is how you publish;
naming in `--parts` is how you compose somebody else's.

`--set-password` is only for the first seed, because after it the printed password is dead. Every
seed after that uses the password you set.

### Two things about `--parts` worth knowing before you need them

**Name every part the release needs, including the ones a part depends on.** `--parts console,auth`
fails with `console requires "ui" (^0.1) and this release has none` — which is the composition
check working, and it is better than a blank page. `cdn.compose` refuses a release with an unmet
requirement, so this failure happens at seed time rather than in a browser.

**Without `--parts` you get every part in the catalog**, which is right for this platform's own
console and wrong for anything else. The first version of the flowboard site booted nine parts,
eight of them somebody else's consoles.

## Checking it from the terminal

Signing in and reading a collection is two calls, and it is worth knowing because the browser is not
always the fastest way to answer *is the data there*:

```bash
T=$(curl -s -X POST http://127.0.0.1:5005/api/identity/ticket \
      -H 'content-type: application/json' \
      -d '{"email":"operator@node.invalid","password":"flowboard-dev-0910"}' \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

curl -s http://127.0.0.1:5005/api/sites -H "authorization: Bearer $T"
curl -s http://127.0.0.1:5005/_describe            # every contract this site exposes, with schemas
```

**`/api/sites` answers two rows on a cluster serving three sites, and that is correct.** `site` is
`scopedBy: 'tenantId'`, so an operator in Platform sees Platform's sites — the control site and the
console — and not `flowboard.localhost`, which belongs to Flowboard Inc. A screen that renders this
list under a heading about the cluster is making a claim the read does not support, which the
console shipped once and no longer does.
