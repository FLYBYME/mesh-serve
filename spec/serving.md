# Serving

The cdn: hostname in, bytes out.

**Status: mounts are Decided and built in the predecessor. Page generation is Decided in shape and
unbuilt.**

---

## 1. A site serves several artifacts — **Decided, built**

The blocker for the whole kernel/apps split was one word: `Site.artifactDigest` was **singular**, and
the serving path resolved every request against that one artifact. A hostname served exactly one
thing, so a site that wanted a framework had **nowhere to reference one from** — which is why every
site copied it in.

A site carries **mounts**: a path prefix and an artifact digest. Longest prefix wins. Two rules,
both with tests, because both fail silently:

**A prefix matches on a segment boundary.** Otherwise mounting `/framework` quietly steals
`/frameworks-of-the-world.html` from a site that already served it. Verified by disabling the check
and watching the test fail.

**A mount is not a redirect.** It resolves within its own artifact, so the entry-document fallback —
serve `index.html` for an unmatched path, which is what makes client-side routing work — applies to
the *mounted* artifact. A kernel artifact has no `index.html`, which is exactly what makes a missing
module return 404 instead of HTML that reaches a developer as `Unexpected token '<'`.

Blobs are shared by digest in the store, so two sites mounting one kernel store it once. The waste was
never storage; it was **different URLs**, and therefore different module instances.

## 2. The page is generated, not written — **Decided**

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
