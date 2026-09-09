/**
 * What can be installed: parts, and their versions.
 *
 * The catalog holds what *may* run. The cdn holds what *does*. Everything a site names resolves
 * through here, so this is the collection that makes `^1.4` mean anything at all.
 *
 * ## One collection, not three
 *
 * A kernel, an Application and an Extension are the same shape with a different `kind`. The
 * difference is cardinality in the *site* — one kernel, many parts — not shape in the catalog. Three
 * collections would be three copies of one resolver, and a marketplace listing would be three
 * queries and a merge.
 *
 * ## Versions are rows, not an array
 *
 * `part { …, versions: [...] }` is the obvious shape and it is wrong three ways: it grows without
 * bound, every publish rewrites the whole document, and it cannot answer the one query that matters —
 * *which version satisfies `^1.4`*. That query is the resolver's entire job.
 */

import { z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- the part

/**
 * **A kind is a build recipe and a host, and nothing else branches on it.**
 *
 * Worth stating because `kind` did not mean much until now: the only behavioural branch in the
 * whole platform was `bundle.ts`'s `external: kind === 'kernel' ? [] : [FRAMEWORK]`, and the browser
 * kernel never reads it at all — a `PartRef` is `{ id, contribution, options }` and
 * application-vs-extension is decided by what the contribution *declares*. So `kind` was doing build
 * configuration while presenting as taxonomy.
 *
 * | kind | build recipe | host |
 * | --- | --- | --- |
 * | `kernel` | bundle, nothing external | the page |
 * | `application` | bundle, framework external | the browser kernel |
 * | `extension` | bundle, framework external | the browser kernel |
 * | `agent` | **none** — it is a declaration | `McpService` |
 *
 * Adding a kind has exactly two obligations: one recipe, one host. If a new kind needs a third
 * change somewhere, the abstraction is wrong and you find out immediately.
 *
 * `agent` has no source at all, which is the simplification that fell out of deciding an agent part
 * *describes* a surface rather than running one (`spec/mcp.md`). A description does not need
 * compiling, so there is no entry, no bundle and no artifact — only a manifest entry a site composes.
 */
export const PartKindSchema = z.enum(['kernel', 'application', 'extension', 'agent']);
export type PartKind = z.infer<typeof PartKindSchema>;

/**
 * Which contracts an agent part offers, per role.
 *
 * **Roles are open-ended strings**, on purpose: a deployment may have `planner` and `worker`, or ten
 * roles nobody else would guess, and the platform has no business enumerating them. What matters is
 * that a role is a role — ten worker accounts hold `worker` and nothing lists the accounts.
 *
 * **Default off.** A contract not named here is on no MCP surface, so adding a contract to a site can
 * never silently widen what a model can reach. The same principle as `auth` having no default: an
 * omission must not mean *open*.
 */
export const AgentRolesSchema = z.preprocess(
    /**
     * **`//`-prefixed keys are comments, and they are dropped here.**
     *
     * `mesh.json` has no comment syntax, so this repository writes them as `//key` members —
     * `//mesh`, `//dependencies`, `//requiredParts` all over the manifests. Every schema that reads
     * one ignores unknown keys and it works by accident. A `z.record` types *every* key, so the same
     * habit inside `roles` produces a role named `//worker` whose value is a string, and the
     * manifest fails to parse with a message about the wrong thing.
     *
     * Written the moment it happened: the first agent part anybody wrote — this one — had a comment
     * in it, put there by following the file's own convention.
     */
    (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('//')),
        );
    },
    z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
);
export type AgentRoles = z.infer<typeof AgentRolesSchema>;

/**
 * Another part this one needs on the page, as a range.
 *
 * A **requirement**, never a grant: it says this part will not function without that one. It does
 * not install it, does not choose its version for the site, and does not decide what it may reach.
 */
export const RequiredPartRefSchema = z.object({
    id: z.string().min(1),
    version: z.string().min(1).describe('A range, or * for any'),
    /** Present-and-useful rather than necessary. Composing reports an unmet optional; it refuses an unmet required one. */
    optional: z.boolean().default(false),
});
export type RequiredPartRef = z.infer<typeof RequiredPartRefSchema>;

/**
 * How to build this part, held by the catalog rather than by the repository.
 *
 * The fields `mesh.json` used to own, minus the two that were never the repository's to state:
 *
 * - **the version**, which is minted by `builder.release_part` now. A repository holding its own
 *   version number is a repository that must be edited to ship, and a number that can be spent.
 * - **the publisher**, which comes from whoever asked, whose scope the API already resolved. A
 *   repository that could name its own owner could name someone else's.
 *
 * There is still nowhere to put an `auth`. A part must never choose its own gate — if a repository
 * could declare `domains.zone_delete` public, installing a part would be a privilege escalation
 * with nobody in the loop — so `requires` is a list of bare contract keys and the site's record is
 * what says at what gate, if at all, each one is exposed.
 */
export const PartDeclarationSchema = z.object({
    /**
     * The **source** entry — `src/app.ts`. esbuild reads types; it does not check them.
     *
     * Optional only because an `agent` part has no source: it is a declaration of a surface, not
     * code that runs. Every other kind must have one, and `catalog.declare` refuses a part that gets
     * this wrong — here rather than in the schema, because the rule depends on `kind` and because
     * the moment somebody is looking at what they just typed is the moment to say so.
     */
    entry: z.string().min(1).optional(),

    /**
     * For an `agent` part: which contracts it offers, per role. Meaningless on any other kind and
     * refused there by `catalog.declare`.
     */
    roles: AgentRolesSchema.optional(),

    /**
     * **The specifier other parts import this one as** — `@flybyme/mesh-core/ui`.
     *
     * Absent on a part nothing imports, which is most of them: an application is composed, not
     * called. Present on a part that publishes a vocabulary or a library, and it is what makes
     * *one shopping cart, run everywhere* mean something rather than one copy per site.
     *
     * A **package subpath**, not a bare name, so TypeScript resolves it through the providing
     * package's own `exports` with no `paths` mapping — the author writes an ordinary import and
     * the compiler checks the props. The builder marks it external and the page's import map points
     * it at the composed artifact, which is exactly what `@flybyme/mesh-web` has always done; this
     * generalises the one specifier that already worked to any number of them.
     *
     * **One URL per specifier, always.** Two would be two module graphs and two of every singleton
     * — the failure named in `bundle.ts`, and the reason a site rather than a part decides what a
     * name resolves to. That is also where the policy lives: two sites may run one application
     * against different `ui` versions, and the release hash covers the difference.
     */
    import: z.string().min(1).optional(),

    /**
     * Which branch a release is cut from. Resolved to an exact commit at release time, always —
     * a build keyed on a branch name would answer the same forever while the code moved underneath.
     *
     * **`HEAD` means *whatever this repository's default branch is*, and that is the only safe
     * default.** It was `main`, which is a guess about somebody else's repository: `mesh-web`'s
     * default is `master`, so the first real import failed with *has no ref "main"* — a confusing
     * answer, because the branch it names is not one anybody chose.
     */
    branch: z.string().min(1).default('HEAD'),

    /** For a monorepo. A name within the repository, never a path on a disk. */
    subdirectory: z.string().min(1).optional(),

    /** The kernel range this is written against, e.g. `^0.15`. Absent when this *is* the kernel. */
    kernel: z.string().min(1).optional(),

    /** Contract keys this part calls — `part.find`, `cdn.deploy`. Bare keys, never a gate. */
    requires: z.array(z.string()).default([]),

    requiredParts: z.array(RequiredPartRefSchema).default([]),
});
export type PartDeclaration = z.infer<typeof PartDeclarationSchema>;

export const PartSchema = z.object({
    /**
     * What a site names when it says it loads this — `auth`, `process-monitor`.
     *
     * Not `id`: `defineCrud` mints that and refuses a schema declaring its own. So the domain key
     * lives beside a minted one, which means uniqueness is a **unique index plus a check**, never
     * the primary key. See `spec/building.md` §4a.
     *
     * **Flat, and that will not last.** Two publishers both wanting `auth` collide, and there is no
     * scoping here yet. npm answers this with `@scope/name`; whatever the answer is, it has to arrive
     * before anyone but us publishes, because renaming a part breaks every site that names it.
     */
    name: z.string().min(1),

    kind: PartKindSchema,

    /** Where the source is. A reference, resolvable by any builder — never a path. */
    repository: z.string().min(1),

    /**
     * Who may publish versions of it.
     *
     * → organization. A `partVersion` row is what a site resolves to, so whoever can write one can
     * change what runs on somebody else's hostname.
     */
    publisher: z.string().min(1),

    /**
     * ## What this part builds, and where the answer lives
     *
     * Everything here was in `mesh.json`, in the repository, and shipping a one-line change meant
     * editing that file — bump the version, commit, publish, build, compose, deploy. Six steps, run
     * by hand, and the first of them existed only because the repository was holding a number the
     * catalog was going to overwrite anyway.
     *
     * So the descriptor is a **genesis format** now, not a build input: `builder.import_repo` reads
     * one once and writes what it found here, and from that moment this row is what a release reads.
     * A repository can still be edited; it just no longer decides anything on its own.
     *
     * **A version keeps its own frozen copy.** `partVersion` records the entry, kernel range and
     * requirements it was published with, so changing this changes what the *next* version declares
     * and can never reach back into one already built. That split is the whole reason this is safe
     * to make editable: identity is on the version, intent is here.
     *
     * Optional, because a part published before this existed has none — and because a part may be
     * declared by hand from the console before anyone points it at a repository. `release_part`
     * refuses one it cannot build from, naming the field.
     */
    declaration: PartDeclarationSchema.optional(),

    /**
     * ## Presentation — everything a person choosing a part needs, and nothing a build does
     *
     * **Identity is immutable; presentation is not**, and that distinction decides which row each
     * field lives on. `name` and `kind` are fixed at first publish and a version's `commit` can
     * never move — but a typo in a description, a new icon, a changed homepage must all be fixable
     * *without minting a version*, because a version means **this code**. Forcing a version bump to
     * fix a sentence would make version numbers meaningless as a record of what changed.
     *
     * So presentation lives here, on the part, and `catalog.publish` updates it on every publish.
     * The one exception is `changelog`, which belongs to a version and is immutable with it — see
     * `PartVersionSchema`.
     *
     * Worth having before a marketplace exists rather than after: a store showing a grid of bare
     * ids is exactly what makes people write descriptions into names.
     */
    description: z.string().default(''),

    /** Where to read more. A project page, a README, a docs site. */
    homepage: z.string().optional(),

    /** An SPDX identifier — `MIT`, `Apache-2.0`, `UNLICENSED`. A string, because it is a label. */
    license: z.string().optional(),

    /**
     * How somebody finds this without knowing its name.
     *
     * Free-form and lowercase by convention rather than by validation: a curated vocabulary is a
     * decision nobody can make correctly before there is anything to curate.
     */
    keywords: z.array(z.string()).default([]),

    /**
     * A path **within this part's artifact**, so an icon is content-addressed like everything else.
     *
     * Not a URL. A URL is a second thing to host, a second thing to expire, and a way for a
     * marketplace listing to reach off the platform — none of which an icon is worth.
     */
    icon: z.string().optional(),
});

// ---------------------------------------------------------------------------- a version

/**
 * What a version of a part *does*, as declared by its own code.
 *
 * A **requirement**, in the same sense as the contracts it calls: the part says what it needs, and a
 * site's policy says what it permits. A part must never state its own permission — if it could, then
 * installing one would be a privilege escalation with nobody in the loop.
 *
 * Three levels of enforcement exist behind this and they must not be blurred:
 *
 * - **declared** — this field. Compose-time refusal. Defeated by an author who just calls `fetch`.
 * - **checked** — the build scans the bundle for direct network use. Defeated by obfuscation.
 * - **enforced** — CSP on the generated page. Defeated by nothing, but it is per-*document*, so it
 *   is a property of a whole release: one part needing network makes the page network-capable.
 */
export const CapabilitiesSchema = z.object({
    /** Capability names from the part's own `needs(...)` — `mesh`, `credentials`, `state`, `log`. */
    needs: z.array(z.string()).default([]),
    /** Provider tokens it contributes, e.g. page chrome. What a site refuses when it says "no chrome". */
    provides: z.array(z.string()).default([]),
});

export const VersionStateSchema = z.enum([
    /** Published, not yet built. The row exists and is buildable — that is the point of it. */
    'declared',
    /** An artifact exists and at least one edge held it. */
    'built',
    /**
     * The artifact was built and no edge holds it any more.
     *
     * Not an error: an edge's disk is a cache, and a pod's storage is deleted on restart. This is the
     * signal to rebuild from `commit`, which is safe because the build is deterministic — several
     * edges discovering it at once all produce the same digest.
     */
    'gone',
]);
export type VersionState = z.infer<typeof VersionStateSchema>;

export const PartVersionSchema = z.object({
    /** → part.name. */
    partName: z.string().min(1),

    /**
     * A semver **label**, and deliberately not an identity.
     *
     * It was one until 2026-09-07: `(partName, version)` was unique and a second publish of `1.0.0`
     * from a different commit was refused with a 409. The invariant was right and the *shape* of it
     * was wrong, because it made a version number a thing that could be spent. Publishing became a
     * negotiation with the catalog — bump `mesh.json`, publish, discover the tree was dirty, bump
     * again — and the escape hatch it needed (`MESH_ALLOW_REPUBLISH`, a server-wide environment
     * variable that let a version be overwritten in place) was the tell: an invariant nobody can
     * live with grows a switch that turns it off.
     *
     * So the label moved off the identity and onto the description. `^1.4` still resolves through
     * it — that is its whole job — and it no longer decides whether a publish is allowed.
     *
     * @see commit, which is the identity now.
     */
    version: z.string().min(1),

    /**
     * The commit this version is, and **the identity of the row**.
     *
     * `(partName, commit)` is unique. Publishing the same commit twice is idempotent no matter what
     * label comes with it; publishing a new commit always writes a new row, even under a label that
     * already exists.
     *
     * The guarantee that mattered survives intact and is now enforced by construction rather than by
     * a check: **an artifact is addressed by the hash of its own content and a release pins digests**,
     * so a release that resolved `^1.4` to some bytes keeps serving exactly those bytes forever.
     * What republishing changes is what `^1.4` will resolve to *next time somebody composes* — which
     * is a thing an operator asks for on purpose, not something that happens underneath a live site.
     *
     * It is also what a rebuild needs: an edge's disk is a cache, so this plus a deterministic build
     * is the entire durability story.
     */
    commit: z.string().regex(/^[0-9a-f]{40}$/),

    /**
     * Where this version's commit lives, and **why it cannot live on the part**.
     *
     * A rebuild is `git fetch <repository> <commit>`, and until now it took the repository from the
     * *part* row and the commit from the *version* row. Those two can disagree the moment a part
     * moves repositories — which became possible on 2026-09-06 when `upsertPart` started updating
     * `part.repository`, and which is exactly what folding `mesh-auth` into a shared core repository
     * would do. Every previously published version would keep a commit that exists only in the old
     * repository, and its rebuild would ask the new one for a ref it has never heard of.
     *
     * So a version records its own. **A version is `(repository, commit, entry, subdirectory)` and
     * all four are immutable together** — `part.repository` means *where new versions come from*,
     * this means *where this one came from*. npm settles it the same way, for the same reason.
     *
     * Optional so the rows published before this existed still read; `build_start` falls back to
     * the part's, which is what those rows have always effectively used.
     */
    repository: z.string().min(1).optional(),

    /**
     * What changed in this version. **The one piece of presentation that is not on the part.**
     *
     * Everything else a person reads — description, icon, homepage — is fixable without minting a
     * version, because it describes the part rather than this code. A changelog entry is the
     * opposite: it describes *this* version, so it is immutable with it, and a changelog you can
     * edit afterwards is a changelog nobody can trust.
     */
    changelog: z.string().optional(),

    /**
     * The source entry within the repository — `src/index.ts`. Part of the build's input hash.
     *
     * Absent on an `agent` version, which has no source: it records a declaration at a commit rather
     * than bytes built from one. `build_start` refuses that kind before it could read this.
     *
     * **`null` is read as absent**, because the database stores an `undefined` field that way and
     * `z.string().optional()` accepts an absent field while rejecting a null one. The first agent
     * part published fine and then failed its own schema on the next release — *"Expected string,
     * received null"*, pointing at a field nobody had set. `publish` no longer writes it; this makes
     * the rows that already exist readable.
     */
    entry: z.preprocess((value) => value ?? undefined, z.string().min(1).optional()),

    /**
     * An `agent` version's role map: which contracts each role may call over MCP.
     *
     * **Versioned, because it is part content and not deployment configuration.** Which roles a
     * surface offers travels with the part the way an application's views do; what a site *grants*,
     * and at what gate, stays the site's (D2). Composing an agent part is what turns the map on.
     */
    roles: AgentRolesSchema.optional(),

    /**
     * The specifier this version is importable as. Versioned with everything else, because a part
     * that renames its public entry has changed what a consumer's bare import resolves to.
     */
    import: z.string().min(1).optional(),

    /** For a monorepo. A name within the repository, never a path on a disk. */
    subdirectory: z.string().min(1).optional(),

    /**
     * The kernel range this was written against, e.g. `^0.13`.
     *
     * "The only thing standing between a stale part and a browser." Enforced at release composition
     * time by `checkComposition`: if the release serves a kernel outside this declared range,
     * compose refuses with a fatal `kernel_mismatch` problem.
     *
     * Absent on a kernel artifact (which has no kernel of its own).
     * On a part, an absent range is accepted rather than refused so that parts published before this
     * field existed remain composable without breaking existing releases.
     */
    kernel: z.string().min(1).optional(),

    /** Contract keys this version calls, by name. Checked against the site's grants at compose time. */
    requires: z.array(z.string()).default([]),

    /**
     * Other parts this one needs on the page, as ranges.
     *
     * Resolved transitively: composing a site pulls in what its parts need, and what *those* need.
     * The failure this prevents is an application that consumes `AUTH` loading onto a page with no
     * auth Extension — which is a blank panel and a console error, not a message anybody can act on.
     */
    requiredParts: z.array(z.object({
        id: z.string().min(1),
        version: z.string().min(1),
        optional: z.boolean().default(false),
    })).default([]),

    capabilities: CapabilitiesSchema,

    state: VersionStateSchema,

    /** → artifact.digest. Absent while `declared`; absent again is not how `gone` is expressed. */
    artifactDigest: z.string().min(1).optional(),

    publishedAt: z.date(),
});
