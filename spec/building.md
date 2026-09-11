# Building

**How a release comes to exist.** A repository holds parts, a part is published at a version, and a
release names a set of versions that a hostname can serve.

`catalog` and `builder` were two domains. Catalog reads and writes only its own rows; builder reads
catalog and writes into it. **Builder is catalog's writer**, and they are one thing.

## 1. The nouns

| | is | is not |
| --- | --- | --- |
| **repository** | a git remote this platform knows about, owned by an organization | a path on a machine |
| **part** | something publishable that lives in a repository | a package |
| **version** | one build of a part, at a commit, with a digest | a tag somebody typed |
| **release** | a named set of versions that compose | a deployment |

**A release is not a deployment.** Composing produces a release; pointing a hostname at one is a
separate act, and that separation is what makes a rollback picking a row from a list.

## 2. A repository is a first-class row, and today it is a string

This is the largest change these specs ask for.

Today `repository` is a **field on every part** — a git URL, repeated on each part that came from the
same place, with nothing keeping them consistent. So:

- *"What repositories does this cluster know about?"* can only be answered by reading every part and
  taking the distinct values.
- A repository cannot be registered before it is imported.
- Nothing records a default branch, or where a monorepo's subdirectory is, except inline at import
  time, every time.

**One repository holds many parts, and that is already true in practice.** `mesh-core.git` produces
`auth`, `identity` and `ui`. `flowboard.git` produces `flowboard` and `flowboard-agent`. The data
model does not say so.

### What it fixes

**The part namespace.** Today a part name is one global namespace, and a second organization
importing a repository whose part names are taken is refused outright:

> `"mesh-web"` is already published by another organization, and a part name is one global
> namespace — so importing … cannot claim it.

With a repository owned by an organization, a part is identified by its path — `platform/kernel`,
`flowboard/kernel` — and the two coexist. **The constraint stops existing rather than getting a
better message.**

See [collections.md](./collections.md) for the nested route this implies.

## 3. What must be true

- **Idempotent, and running it twice is how you find out.** Importing declares or updates; releasing
  is cached when the commit has not moved; composing the same parts is the same release; deploying a
  release a site already serves changes nothing.
- **A version is minted, never declared.** A repository that holds its own version number is a
  repository that must be edited to ship, and a number that can be spent twice.
- **A part belongs to its publisher**, and a repository that could name its own owner could name
  somebody else's.
- **A composition is refused at compose time, not in a browser.** A release naming a part it does not
  have, or a part whose requirement is unmet, fails when it is built. The failure moves from a blank
  page to a build, which is the whole point.
- **A reference, never a path.** A repository is resolvable by any builder on any node.

## 4. Timeouts are a design constraint here, not a setting

The broker's default call timeout is ten seconds, which is right for a question and wrong for work.
Releasing one repository is a clone and a bundle per part and has taken twenty-two seconds on a warm
machine.

The failure this produced is worth keeping: **the caller timed out and reported `RPC Timeout` while
the builder carried on and finished every part correctly.** The run failed and the work succeeded,
which is the most confusing pair of outcomes available. Anything that clones or bundles declares its
own timeout, and a caller that gives up must not leave the work unattributed.

## 5. Open

- **The repository collection itself** (§2), and migrating `part.repository` to reference it.
- **Whether building belongs in this package at all.** It is the piece with the fewest ties to
  serving: it produces artifacts and a release row, and serving reads them. It could be a separate
  service that a node runs, or does not.
- **Where a bare repository path fits.** Local development imports from `/home/…/.git-remotes/x.git`,
  which is a reference that resolves on exactly one machine. Honest for a laptop, wrong for a fleet.
