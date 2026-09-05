# mesh-serve

The serving section of the platform: **turn a repository into content-addressed artifacts, compose
them into sites, and hand them out.**

Written down 2026-09-05, at the end of a day spent taking `mesh-web` apart. Most of what follows was
found by running something rather than by designing it, and where that is true the document says so —
a finding that came from looking at a screen is worth more than a paragraph that sounds right.

## The documents

| | |
| --- | --- |
| [composition.md](./composition.md) | What a site is: a hostname, a kernel, and a set of parts. `mesh.json` after it stops being a file. |
| [building.md](./building.md) | What a build is: no install, framework external, one artifact per part. |
| [serving.md](./serving.md) | The cdn: an artifact's URL is its hash, the generated page, styles and themes. |
| [exposure.md](./exposure.md) | What goes on the internet: contracts by name, gates, and the CRUD discipline that paas did not have. |
| [fleet.md](./fleet.md) | Nodes announce, fleet reacts. The standard way to run a service anywhere. |
| [roadmap.md](./roadmap.md) | **The gap between those documents and `src/`**, in dependency order. Start here. |

## What this repository is

Five ServiceModules that ship together — `api`, `builder`, `catalog`, `cdn`, `fleet` — plus
`identity`, which arrived first because it was already written.

**The unit of a repository is a section of the product, not a service.** Named for the section, never
for one of its contents: a container called `mesh-api` that also held a CDN would repeat the mistake
that took a day to unpick in `mesh-web`, where a browser framework had grown a build system and every
question about the repository had two answers. The clearest symptom was `npx mesh generate` writing a
server artifact into the tree whose one rule is that nothing there imports node.

So: `mesh-serve` for serving, and `surfdns-domains`, `surfdns-routes`, `surfdns-proxy` and so on for
the sections of the product, each holding however many services that section needs.

## What is not here

**The browser runtime.** That is `mesh-web`. It is a dependency of the *sites* this serves and never
of this. Nothing in `src/` may import it.

**Anything that decides what a product is.** A site record says a hostname is a kernel and some parts;
what those parts *do* is the product's business, in the product's repository.

## Three properties everything else rests on

**Content addressing.** An artifact is bytes and a hash, never a location. The predecessor stored an
absolute path on whichever node built it, so nothing could be built elsewhere and nothing could move
once built. Every type here is shaped so that is unrepresentable.

**Declared, desired, observed.** What exists is written by a build. What should run is written by a
person. What *is* running is written by the thing running it. Three writers, so three fields — and
"what is this actually running" stays answerable, which is the question the previous generation could
not answer about itself.

**Generate everything, expose almost nothing.** `defineCrud` gives ten actions per collection for
free, and they belong on the mesh. What is reachable from outside is a separate, much smaller, and
deliberate decision. See [exposure.md](./exposure.md) — this is the specific way 100,000 lines of
paas went wrong.
