# The CLI

**Status.** Proposed, 2026-09-08. Nothing is built.

A terminal client for any site on this platform — not for this platform. Companion to
[mcp.md](./mcp.md) and [exposure.md](./exposure.md).

## 1. It is the fourth projection

```
describeExposure  →  ApiService   →  HTTP routes
                  →  client-cli   →  a typed client
                  →  McpService   →  agent tools
                  →  the CLI      →  subcommands
```

The first three do not decide what is callable. They read the descriptor — `visibility`, the site's
grants, the gate level — and serve what is there. Adding a contract adds a route, a client method and
a tool without anybody editing a table.

**The CLI is the same, and it is the one that has not been built that way.** Every hand-written
subcommand is a second place a contract has to be added, and the second place is the one that gets
forgotten.

> The commands are the contracts.

## 2. It talks to a node; it is not one

`src/bring-up.ts` starts its own `MeshApp`, joins the mesh, and calls the broker directly. That is
why running it prints a peer connecting and disconnecting, and it is the wrong shape for three
reasons:

- **It needs the mesh key**, so it only works from a machine that is already a cluster member. A CLI
  should work from a laptop against a remote cluster with nothing but a URL and a ticket.
- **It authenticates differently from everything else.** `bring-up` mints its own caller; `publish-cli`
  did too until **F6** fixed it — *"the CLI minted its own caller and nothing checked it"*. Two auth
  stories is one too many, and the second one is always the weaker.
- **It bypasses the gate.** A broker call is not an HTTP request: no site, no grants, no scope. What
  the CLI can do and what a person can do stop being the same set, and only one of them is tested.

**So: an HTTP client, holding a ticket, calling the same api a browser calls.** Nothing it does
should be reachable in a way a browser could not reach.

## 3. The commands come from the *site*, which is what makes it general

This is the part that matters for more than one project.

`mesh-serve` does not know what surfdns is, and must not. What it knows is how to read a descriptor.
So the command tree is a function of the host:

```bash
mesh-serve --host flowboard.localhost   card create --title "…"
mesh-serve --host surfdns.net           domain add   --name example.com
mesh-serve --host console.surfdns.net   site deploy  --host … --release …
```

Same binary, three command trees, none of them written down anywhere. A site that exposes
`domain.create` has a `domain create` command *because it exposes it*, and a caller whose gate refuses
it does not see it — the same rule as `tools/list` in [mcp.md §3](./mcp.md).

**That is what "the basics for everyone" means.** surfdns will want its own client — a `surf` binary
with its own vocabulary, its own defaults, its own idea of what a domain is. It should build on this
rather than beside it: the generic client is what makes a dedicated one a *layer* instead of a
reimplementation.

The platform's own operations — catalog, builder, cdn, fleet — are not special. They are the
descriptor of the site an operator points at.

## 4. Authentication, and the first boot problem

```bash
mesh-serve login --host console.surfdns.net      # asks, stores a ticket
mesh-serve whoami
```

One ticket, stored per host, used by every later command. `identity.ticket_issue` already exists and
is exposed; this is a client for it, not a new mechanism.

### The first user

**A cluster with no accounts cannot be signed into, and everything requires a session.** Today that
is solved by `bring-up` minting a caller, which is the bypass §2 wants removed — so removing it
leaves a real hole that has to be filled deliberately.

The answer: **on first boot, when the account collection is empty, identity creates one temporary
operator and prints its credential to the node's own stdout.** Three properties, and each is a
refusal of something easier:

1. **Printed to the console, never stored as a default.** A well-known default password is a
   platform that ships pre-compromised. It appears once, in the log of the process that made it, and
   whoever can read that log is already on the machine.
2. **It is a real account with a real password**, not a bypass. It goes through `identity.register`
   like anybody else, so there is exactly one path to a session and no branch that skips a check.
3. **It is marked `provisional`, and a provisional account may do nothing except change its own
   password.** Not a warning, not a nag — a refusal. Every other contract answers `needs_session`
   for it. That is the difference between "you should change this" and "nothing works until you do",
   and only the second survives a busy week.

Clearing `provisional` is the platform's first real write, and it happens through a contract like
everything else.

**Why not skip it and have `mesh-serve init` create the operator?** Because that is `bring-up`'s
bypass with a nicer name: something has to be able to write a user without being one, and the moment
that exists it is the weakest thing in the system. A provisional account that can only fix itself is
the smallest hole that still lets a person in.

## 5. What it replaces

`src/bring-up.ts` is seven jobs behind one command: create an account, create an organization, assign
services, import repositories, release parts, compose a release, create a site, deploy it. **You can
run none of them individually**, and any failure abandons the rest — a compose that refused tonight
had already done six things correctly and the only way to retry was to redo all six.

Its own header knows: *"every step is a contract call, and every step is a function that can be
called on its own."* The decomposition exists in the code and cannot be reached from a terminal.

So each step becomes a command, and **`seed` survives as a script over them** — for a fresh cluster,
and no longer the only way in. "It does too much" then stops being a problem, because doing less is
a matter of calling fewer commands.

## 5a. `init` writes files; it does not touch a cluster

`mesh-serve init` scaffolds a project — a service and a UI part, a `mesh.json`, the two entry points
wired to each other — and **stops there**. No node, no database, no site, no account.

That is the opposite of `seed`, and deliberately: `init` is *"give me something to edit"* and `seed`
is *"make a cluster that serves it"*. Merging them is what produced a command that did seven things
and could not do one.

**It assumes whoever ran it set it up, and it does not serve publicly.** A scaffold that binds a
public port is a scaffold that ships an unfinished thing to the internet the first time somebody
tries it on a box with a real IP. Bind loopback, say so in the generated README, and let the person
who wants otherwise say otherwise.

## 5b. `mesh.json` is a seed, and the catalog is authoritative

This is already the design and it is worth stating in the place a person looks, because the file's
continued existence reads as a contradiction.

`import_repo`'s own header: *"`mesh.json` → `catalog.declare`, once per part → the catalog is
authoritative. **This is the last thing that reads `mesh.json`.** The file is a genesis format… a
repository editing its descriptor afterwards has changed nothing until somebody imports it again."*
And `build_start`: *"`mesh.json` is not read here at all."*

So the lifecycle is:

```
mesh.json  →  import, once   →  part rows      →  the catalog, from then on
                                                  ↳ edited through contracts, not by editing a file
release    →  reads the catalog                →  builds, mints a version, publishes an artifact
```

**`--config` follows from that rather than changing it.** A seed read once has no reason to live
inside the repository being seeded:

```bash
mesh-serve catalog import <repo> -c ./flowboard.mesh.json
```

Said once. After that the part rows are the truth, managed through the api like everything else, and
a release is a trigger rather than a re-read. Three things it buys:

- **A repository does not have to carry platform metadata to be publishable.** Somebody else's
  library becomes a part without a pull request.
- **The declaration can be corrected without a commit.** Today a wrong `entry` means editing the
  repository and re-importing; the catalog already holds the field and nothing else needs to change.
- **It makes the one-read rule visible.** A file passed on the command line is obviously a seed. A
  file sitting in the repository looks like configuration, which is why it keeps being mistaken for
  it.

The one thing to hold onto: **`(partName, commit)` stays the identity.** A config that could change
what an already-published version means would undo the reason the catalog is authoritative in the
first place.

## 6. What blocks it

**F7, and it is on the critical path.** `mesh generate` already emits a CLI command tree from
contracts, and it is broken: `--version` collides with commander's own program-level flag, so any
contract with a `version` input prints the CLI's version and exits **0**.

```
$ npx mesh builder build_start --part todo --version 0.1.0
1.0.0
```

No build, no error, exit 0 — a command that looks like it worked. It hits `builder.build_start`,
`catalog.publish` and all eight `partVersion` commands. A generated CLI cannot ship over that.

## 7. Where this leaves `mesh`'s own CLI — **decided 2026-09-09**

> "npx mesh is no longer something that can be used and should be removed. Everything that the
> package mesh-serve provides must be managed through the api and the cli. This is a must now.
> Nothing else."

Settled the way this section anticipated. The framework's CLI was written when a contract call was a
call on a broker by whoever held one; **`scopedBy` and the gate changed what a caller is**, and a CLI
that predates tenancy cannot express it. It does not merely fail to express it — it *bypasses* it:
`npx mesh <domain> <action> --bootstrap ws://…` joins the mesh as a peer, and a joined peer
constructs whatever `meta` it likes, so `requireOperator` reads what the caller said about itself
(roadmap D6). The framework CLI is not a door to this platform.

**`mesh-serve` is the CLI.** It is descriptor-driven — it reads `/_describe` from a site and
dispatches — so every command is an authenticated HTTP call through the same gate as a browser's,
and there is nothing it can reach that a person could not.

What made that possible was the missing piece rather than a rewrite: a cluster with no sites had
nothing to point a CLI at, because the api dispatches by `Host`. **A node now serves a control site
for itself** (`cdn/methods/control.ts`), so `login`, seeding and token issuing are ordinary calls
against an ordinary site:

```
node bin/mesh-serve.mjs node --db <fresh>        # prints one password, once
node bin/mesh-serve.mjs seed --password … --set-password … \
    --host example.localhost --repo … --parts …
```

`src/bring-up.ts` was the last thing joining the mesh to make privileged calls; it is an HTTP client
now, and `callerFor` and `MESH_BOOTSTRAP_OPERATOR` are deleted. `publish-cli` was moved off the same
shape by F6.

**`npx mesh` remains what it always was for**: `mesh generate`, run inside a repository against its
own source. That is a build-time tool over files, not a way to reach a running cluster, and F7 below
is about that generator rather than about driving contracts.

## 8. Open

- **Where a ticket is stored.** `~/.mesh/credentials`, per host. Permissions and what happens on a
  shared machine are not decided.
- **Whether `--host` is required every time**, or a current host is remembered like a kubectl
  context. Remembering is friendlier and is how somebody deploys to production believing they are on
  staging.
- **Output.** A tool's result is JSON; a person wants a table. `print` already exists on contracts
  and is the obvious source, with `--json` for anything reading it.
- **How a site's *service* gets running.** The CLI can create a site for flowboard, but flowboard's
  own contracts have to be mounted somewhere. That is `node.provision` plus `node.assign`, and it is
  a fleet question rather than a CLI one — but a person setting up a project will hit it in the same
  five minutes, so the CLI should at least name it.
