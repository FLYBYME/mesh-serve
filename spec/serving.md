# Serving

The cdn: hostname in, bytes out.

**Status: the URL space and the page generator are Decided and built as pure functions
(`src/cdn/methods/`). Nothing is wired to a broker or a port yet.**

---

## 1. An artifact's URL is its hash — **Decided, built**

The blocker for the whole kernel/apps split was one word: `Site.artifactDigest` was **singular**, and
the serving path resolved every request against that one artifact. A hostname served exactly one
thing, so a site that wanted a framework had **nowhere to reference one from** — which is why every
site copied it in.

The first fix was **mounts**: a chosen path prefix per artifact, longest prefix wins, matching on a
segment boundary so that `/framework` could not steal `/frameworks-of-the-world.html` from a site
that already served it. That worked, and the bug it had to defend against is the argument for not
naming artifacts at all.

**Superseded 2026-09-06.** An artifact is bytes and a hash, so its URL is its hash. Every composed
artifact is served under one reserved prefix — `/_a/<hash>/` — and the site's own generated page
answers everything else.

| | mounts | hashes |
| --- | --- | --- |
| can a new part shadow an existing page? | yes, unless the boundary rule holds | **no** — there is one reserved prefix |
| cache header | per file, decided by looking at the name | **per URL**: `/_a/` is immutable, the page is not |
| redeploying a part | same URL, new bytes | **new URL**; the old one is not stale, it is unreferenced |

The cost is unreadable URLs in a network tab, paid once by whoever is debugging, against a class of
collision paid by whoever deploys. `spec/composition.md` already said a part is chosen by version and
served by digest; this makes the URL say the same thing.

**A site may only serve what it composed.** The digest in a URL is a claim, checked against that
site's own `resolution`. Without the check `/_a/<any digest>/` is an open proxy into every other
tenant's code — served from *this* site's origin, which is the boundary the isolation model rests on.
It is a 404, not a 403: which artifacts exist is not something an anonymous request gets to probe.

**The entry-document fallback belongs to the artifact, not the site.** Serving `index.html` for an
unmatched path is what makes client-side routing work, and it applies within whichever artifact
answered. A part artifact has no `index.html`, so a missing module 404s instead of returning HTML
that reaches a developer as `Unexpected token '<'` — without needing a rule of its own.

Blobs are shared by digest in the store, so two sites using one kernel store it once. The waste was
never storage; it was **different URLs**, and therefore different module instances.

## 2. The page is generated, not written — **Decided, built**

Nobody writes `index.html`. Nobody writes a boot file.

The predecessor's boot file, `main.ts`, reached into `document.getElementById('console')` — an element
a hand-written page had to have created. Five undeclared contracts between a bundle and an HTML file:
`#console`, `#notifications`, a stylesheet defining `.window` and `.titlebar`, an import map, and
`data-api`. Nothing declared them, nothing checked them, and getting one wrong rendered a blank or
half-styled page.

It also ended with `export { page }` that **nothing imported** — the file already knew it should be
handing the page to something. There was no something.

So the cdn composes and emits:

- **`index.html`** — the shell, with the import map pointing at the mounted kernel
- **the boot module** — which parts to load and in what order, from the composition
- **the theme** — token *values*, which come from the composition rather than from any bundle

and links what the kernel and parts already carry.

**Generated when the composition changes, not per request.** The output is hashed and stored like any
other artifact — otherwise it becomes the one thing in the system that is not content-addressed and
needs its caching special-cased.

The inversion this completes: the kernel loads a part and the part hands back what it built. Then
`getElementById` goes, the notification surface stops being an app writing raw `createElement`,
`export { page }` becomes real, and `index.html` has nothing left to do.

### 2a. The cdn generates a composition, never framework code — **Decided**

The rule that keeps the generator small, and the reason it *is* small.

The console's `main.ts` was 140 lines. Almost none of it was about that console: it constructed a
`WindowManager`, chose four settings hives and their providers, installed `windowPersistence`, wired
`kernel.services.meshClient` through `withHeaders`, built a component registry from `PRIMITIVES`,
called `mountPage`, ran an `effect` to render notifications into `#notifications`, and added a resize
listener. **Identical on every site**, all of it.

If the cdn generated that, the cdn would have to be updated whenever the kernel changed — a code
generator that tracks another package's internals is a second copy of that package. So it generates
only what it actually knows:

```js
import { start } from '/_a/9f2c1a/index.js';
import part0 from '/_a/3ab77e/index.js';
import part1 from '/_a/c40d21/index.js';

start({
    application: 'surfdns-console',
    api: document.documentElement.dataset.api ?? '',
    policy: { "window-manager/mode": "tiled" },
    parts: [
        { id: 'chrome', contribution: part0 },
        { id: 'process-monitor', contribution: part1 },
    ],
});
```

**The order in `parts` is not the order they start.** The kernel resolves that from what each part
provides and consumes, which is also what lets the generator emit them in id order and stay
deterministic — the page is hashed, so non-determinism would mean a new digest on every deploy that
changed nothing.

**`start` does not exist yet.** That is the point of writing the file first: the generated output is
what says what the kernel owes. Logged against mesh-web, not here — a kernel entry point is the
framework's job, and putting it in the cdn is how the 140 lines got written the first time.

Two smaller things the page settles:

- **The import map resolves the framework to exactly one URL.** A part is built with the framework
  `external`, so its bare `import … from '@flybyme/mesh-web'` has to resolve somewhere; two URLs
  would be two module graphs and two of every singleton, which no amount of testing one part at a
  time would reveal. There is a test asserting the map and the boot module name the same URL.
- **The theme is checked, not trusted.** A site record is written by its owner, who is not
  necessarily the operator of this cdn, and the page is the platform's own output. A token value
  containing `}` would close the rule and let a site write arbitrary CSS into a document it does not
  own. Refused loudly — silently dropping a token is a theme that is subtly wrong with nothing to
  point at.

## 3. Styles and themes — **Decided in shape**

**The kernel owns the rules. The site owns the values.**

```
.window { background: var(--surface); color: var(--ink) }   ← kernel, one stylesheet
```

Two instances of one application, side by side, under different themes: identical rules, different
custom-property values on each window's host element. Custom properties inherit, so everything inside
a window picks up its own instance's tokens. **No shadow DOM, no build-time scoping, no collisions** —
there is only one set of rules, so there is nothing to collide.

The seam already exists: the kernel writes inline styles on each window host for geometry — *whoever
writes `left` owns `position`* — and a theme is more properties on the same element.

**Apps are concurrent, not sequential.** This is a window manager; several parts are on screen at
once. So there is no "switch the styling" — each window always looks like its own part, and you see
all of them together. **Focus changes what is on top, not what things look like.**

Three layers, three owners:

| | whose theme |
| --- | --- |
| page chrome — banner, tab strip, status line | the site's. Never changes on focus. |
| the window frame — title bar, buttons, grip | **chrome's**. It is a window-manager control, not the part's. |
| window content | **the part instance's** |

A part may *hint* light or dark and chrome picks its own matching variant — what desktop systems do.
Furniture that changes colour when you click is disorienting.

### The constraint this creates, and it is falsifiable

If the kernel owns the rules, then **a part needing a class the kernel does not have is reporting a
missing component, not a missing stylesheet.** An Application's vocabulary is components — `Stack`,
`Text`, `Button` — never tags.

By that test the predecessor's console is evidence against readiness: `.console-banner`, `.panel`,
`.module`, `.org`, `.mono`, `.dim` — two hundred lines of a part drawing its own furniture. So this
model puts real pressure on the component library, and that is the honest cost of it.

## 4. Policy is enforced here — **Decided**

Not baked into a build. Changing a policy should not mean rebuilding a part that did not change, and
policy is a property of a deployment rather than of any artifact.

## 5. Open

- **Whether the window frame ships with the kernel at all.** `defaultFrame` names `.window`,
  `.titlebar`, `.buttons`, `.grip`, and the *site* styled them — the framework naming elements nobody
  in the framework styles. Either the frame's rules ship with whatever provides the frame, or the
  kernel stops shipping a frame.
- **Theme as a publishable thing.** See [composition.md §6](./composition.md).
