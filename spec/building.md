# Building

**Status: Decided.** No code yet.

---

## 1. There are two kinds of bundle — **Decided**

**The kernel**, and **parts**. An Application and an Extension are the same kind of artifact with a
different `kind`; the only difference is that an Extension is installed and singleton while an
Application is run and may have several instances. So: two kinds, not three.

Both are versioned and hashed. The kernel is built and bundled to its version and hash exactly as a
part is.

## 2. A part artifact must not contain the kernel — **Decided, and it is correctness**

**`mesh-ui` got this wrong in the one line that mattered.** Its esbuild `external` list named node
builtins and server packages — `node:fs`, `express`, `mongodb`, `ws` — and a plugin aliased
`@flybyme/mesh` to a browser build, which esbuild then **inlined into every extension**. Every part
carried its own framework.

That is not a size problem. A browser resolves modules by URL, so two copies under two URLs are two
module graphs and **two of every singleton the capability model depends on**. The whole of
`needs()` / `provides()` assumes one kernel.

So the framework is `external`, always, and the page's import map resolves it to the one mounted
kernel artifact. This is the single line separating "one kernel, many parts" from "many kernels
pretending".

Measured on the last artifact built the old way: `out/framework` was 1.1 MB across 192 files against
`out/app`'s 72 KB across 8. **94% of every artifact was a private copy of the kernel.**

## 3. A build does not install — **Decided**

Fetch the commit, run esbuild, hash the output. No `npm i`, no network, no `node_modules`.

This is possible because **esbuild does not typecheck.** It strips types and emits. A part whose only
dependency is the framework — which is external — needs nothing installed at all.

The predecessor ran `npm ci` inside every build, which cost a measured **95 to 125 seconds per site**
and made the framework a git clone on every build. That is not an optimisation to make later; it is
the difference between a marketplace and a form that occasionally works.

**Typechecking is the author's job**, in their own repository, before they push. A build server is the
slowest possible place to discover that a type is wrong.

### The rule that makes it hold

**Vendored or external.** The framework is external. Anything else a part uses is committed to the
part's repository. There is no resolution step, so a missing dependency is a build failure rather
than a network round trip — and a build is reproducible from a commit with nothing else in the world
required.

### 3a. A repository names an entry, not a command — **Decided**

The consequence of §3, and it is a bigger change than it sounds.

The predecessor's descriptor carried `ui.build` — a shell command the builder ran with `sh -c` — and
`ui.output`, the directory it was expected to have written. That is what made `npm ci` possible in
the first place, and it made the builder's threat model *arbitrary code from a repository*.

There is no `build` field now. A part declares an **entry** — `src/app.ts` — and the builder runs
esbuild against it. What a repository can ask for is a bundle of its own source, and nothing else.

What is given up: a repository can no longer run a pre-build step. That is deliberate — a pre-build
step is where `npm ci` came back, and a build that runs a repository's own tooling is a build that
cannot be reproduced from a commit alone.

### 3b. Requirements are declared per part, not per repository — **Decided**

A repository builds several parts: `surfdns-console` is a chrome extension and an application in one
tree. `mesh` — the contracts a part calls — hangs off each part, not off the repository.

A repository-level list would make every part declare every contract any of them calls, so a site
loading only the chrome extension would have to grant it the domain contracts the console app uses.
**Over-declaring a requirement turns the grant check into a formality**, which is the one thing it
must not become.

## 4. An artifact declares what it is — **Decided, built in the predecessor**

An artifact carries a `Declaration`: the parts it provides, and `builtAgainst` — the versions it was
actually linked against, read from the built tree rather than from a range, because `^1.2.0` is a wish
and the installed version is the fact.

**And for a git dependency the version identifies nothing.** `@flybyme/mesh-web` reports `0.1.0` and
will report `0.1.0` on every build forever, because nothing bumps the version of a package consumed
from a branch. The field added specifically to catch a framework mismatch was constant across every
framework change. The lockfile has the real identity, so the **commit** is recorded alongside.

Found by running it against a real repository after the unit tests passed on the first try and proved
nothing. The same run found that reading only a root `package.json` returns nothing at all for an npm
workspace — which is not an exotic layout, it is what a repository with two halves naturally is.

## 5. Verification happens at build time — **Decided**

A site's `mesh[]` names contracts as strings. With an imported `ToolContract`, a wrong name was a
compile error; with a string, nothing catches it and the failure looks like a 404, indistinguishable
from a route that never existed.

The `package` field is what recovers this. **The build asks whether that package really exports those
contracts**, and fails if not — which also hands the client generator its schemas.

It asks the **catalog**, not npm. A service package publishes its contract descriptors when it is
released, so a build needs nothing installed and stays offline. Everything a build consumes comes
from one place.

## 6. What is generated, and by whom

- **the builder** — part artifacts, kernel artifacts, and the typed client for a repository, because
  the builder is the only thing that ever has a repository checked out
- **the cdn** — the page, the boot module and the theme, because those come from a *composition*
  rather than from any single repository. See [serving.md](./serving.md).

## 7. Open

- **Whether the kernel is one file or many.** Unbundled ES modules give per-file cache granularity,
  which matches content addressing: change one module, refetch one file. One bundle means every
  client refetches a megabyte for a one-line change. Against that, 192 requests on a cold load. Once
  the kernel is shared and immutable, that cost is paid **once per kernel version per browser, across
  every site**, which weakens the argument for bundling it considerably. Measure before deciding.
- **Where the client generator runs.** A part repository needs types in an editor with nothing
  running. See [exposure.md §4](./exposure.md).
