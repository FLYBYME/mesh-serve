/**
 * What the builder owns: builds, and the artifacts they produce.
 *
 * Two collections and three explicit contracts, and the split between them is the rule this
 * repository follows everywhere — **CRUD is generated in full and used idiomatically; anything that
 * has a side effect or an invariant is an explicit contract that does the work and then writes
 * through the normal CRUD path.**
 *
 * So: an artifact record is CRUD, because reading one is a read. Producing one is not — it fetches a
 * commit, runs a bundler and stores bytes — so `build_start` exists and `artifact.create` is never
 * called by anything but the builder itself.
 *
 * ## What is never exposed
 *
 * `artifact.find` and `build.find`. An unbounded find has no notion of the caller's scope, so it
 * would enumerate every artifact on the platform — every tenant's repository names, versions and
 * deploy history. Authorization can refuse a *caller*; it cannot narrow a *result set*.
 */

import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { ArtifactSchema } from '../schema/artifact.js';
import { BuildSchema, SourceRefSchema } from '../schema/build.js';

// ---------------------------------------------------------------------------- collections

export const artifactCrud = defineCrud('artifact', ArtifactSchema, {
    /**
     * The default `id`, though the digest *is* the identity — and this is the one place where the
     * framework and content addressing genuinely disagree.
     *
     * `defineCrud` omits the id from its create input, so an artifact cannot be created *at* its own
     * digest: the database mints an id and the digest is a field beside it. Every artifact therefore
     * has two identities, one of which means something.
     *
     * The consequence was a real invariant with nowhere to live: **two rows could claim the same
     * bytes**, which content addressing exists precisely to prevent. mesh 2.4.0 closed it — see
     * `unique` below — so the two identities remain and only one of them can be duplicated.
     */
    pluralPath: 'artifacts',

    /**
     * **Global, not scoped, and that is the interesting half.**
     *
     * An artifact is addressed by the hash of its content, so two organizations building the same
     * source produce the same digest and *have produced the same artifact*. Scoping this would store
     * identical bytes once per tenant and discard the property that makes a build cacheable at all —
     * which is the opposite mistake from `site.host`, where a global key is what prevents a takeover.
     * Two collections, two answers, neither of them a default.
     */
    unique: [{ fields: 'digest', scope: 'global' }],
    // Reading and writing an artifact record touches no other domain. Publishing one does — it asks
    // the catalog to register a version — and that is `build_start`'s job, not a hooked create.
    dependencies: [],
});

export const buildCrud = defineCrud('build', BuildSchema, {
    pluralPath: 'builds',
    dependencies: [],
});

// ---------------------------------------------------------------------------- doing the work

export interface ContractRequirements {
    /** Minimum required memory in MB (e.g. 2048 for builder.build_start). */
    readonly memory?: number;
    /** Whether this service prefers running on a node already holding the data. */
    readonly preferData?: boolean;
}

declare module '@flybyme/mesh' {
    interface ToolContract {
        readonly requirements?: ContractRequirements;
    }
}

export const buildStartContract = defineContract({
    domain: 'builder',
    action: 'build_start',
    description: 'Build one published version of a part into its artifact.',
    dependencies: [],
    /**
     * **512MB, measured — it was 2048, guessed.**
     *
     * The guess had a real cost: surf has 981MB, so it refused every build, and the fleet's only
     * public node could not do the one thing the whole loop needs. The workaround was a second
     * machine, which is a strange conclusion to reach about bundling 30KB of TypeScript.
     *
     * Measured on 2026-09-07 by cloning mesh-core and bundling four of its parts in one process:
     * **70MB peak RSS**, flat across all four — because esbuild is a Go binary with its own memory
     * outside node's heap, and what node holds is the file contents, which for every part in this
     * platform is between 2KB and 125KB.
     *
     * 512 is seven times the measurement, which leaves room for a repository much larger than any
     * here while still refusing a genuinely tiny box. It also fits inside the `MemoryMax=600M` that
     * surf's systemd unit sets, so a node that accepts the work can survive doing it.
     *
     * The failure this constant was written after is real and was not memory: `node.hello` returned
     * raw `services` and ignored groups, so surf was told to run nothing, fell back to starting
     * everything, and took builds while doing all of it. That is fixed. A number invented to work
     * around a bug outlived the bug, which is the argument for measuring rather than estimating.
     */
    requirements: {
        memory: 512,
        preferData: true,
    },
    /**
     * **A part and a version — never a repository URL.**
     *
     * It took one until a credential existed, and then the shape was a hole: the caller named the
     * repository, so a node holding a token that can read a private repository would clone it for
     * whoever asked, bundle it, and publish an artifact addressed by a digest that same caller could
     * fetch. Not a flaw in the token; a flaw in accepting an arbitrary URL while holding one.
     *
     * The catalog already had the answer. A `part` row carries `repository` and `publisher`, so the
     * repository comes from the catalog and the caller is checked against the publisher — and there
     * is no longer a field in which to name somebody else's repository.
     *
     * It also makes a build reproducible from the catalog alone, which is exactly what an artifact
     * that has gone `gone` needs in order to be rebuilt. The security fix and the durability path
     * turn out to be the same change.
     */
    inputSchema: z.object({
        part: z.string().min(1).describe('→ part.name'),
        version: z.string().min(1).describe('An exact published label, never a range'),
        /**
         * Which commit, when the label names more than one.
         *
         * A label stopped being unique on 2026-09-07 — `(partName, commit)` is the identity — so
         * `version` alone resolves to *the most recently published row carrying it*, which is what
         * a person means by "build 0.2.4" and is still ambiguous to a machine. A caller that already
         * knows the commit says so and gets exactly those bytes.
         */
        commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
        preferLocal: z.boolean().optional().describe('Prefer local execution for work that is cheap locally and expensive remotely'),
    }),
    outputSchema: z.object({
        part: z.string(),
        version: z.string(),
        buildId: z.string(),
        state: z.string(),
        artifactDigest: z.string().optional(),
        /** True when an identical input hash was already built and nothing ran. */
        cached: z.boolean(),
    }),
    rest: { method: 'POST', path: '/builder/builds' },
    destructive: true,
    print: (o) => `${o.part}@${o.version}: ${o.state}${o.cached ? ' (cached)' : ''}`,
});

/**
 * Read a repository's `mesh.json` and declare what it describes.
 *
 * **The one job `mesh.json` still has, and the last one it will have.** It is a *genesis* format:
 * this reads it once, writes what it found onto `part` rows, and from then on the catalog is what a
 * release reads. Nothing in the build path opens it again — see `catalog.declare`.
 *
 * That is the difference the file could never express on its own. A descriptor in a repository is
 * read at the moment somebody runs a command in a checkout, which is why shipping needed a person
 * with the tree open. A row is read by whatever asks, from wherever it runs.
 *
 * Editing the file afterwards changes nothing until this is called again — deliberately. The
 * console is the place to change what a part builds, and a repository quietly redefining itself on
 * the next build is exactly the coupling being removed.
 */
export const importRepoContract = defineContract({
    domain: 'builder',
    action: 'import_repo',
    description: 'Read a repository descriptor and declare the parts it describes.',
    dependencies: [],
    inputSchema: z.object({
        repository: z.string().min(1).describe('A clonable reference — never a path on a disk'),
        // `HEAD` is the repository's own default branch, whatever it is called. Defaulting to `main`
        // is a guess about somebody else's repository, and the first real import proved it wrong.
        ref: z.string().min(1).default('HEAD').describe('Branch, tag or commit to read the descriptor at'),
        subdirectory: z.string().min(1).optional().describe('Where in the repository the descriptor is'),
        /** Report what would be declared and write nothing. */
        dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
        repository: z.string(),
        commit: z.string().describe('What the ref resolved to, so an import is a fact about a commit'),
        parts: z.array(z.object({
            name: z.string(),
            kind: z.string(),
            /** Absent on an `agent` part, which declares a surface and has no source. */
            entry: z.string().optional(),
            /** False when this import created the part. */
            existed: z.boolean(),
            /**
             * **The declared version — for a kernel, and only for a kernel.**
             *
             * Every other part's version is *minted* by `release_part` from what was actually
             * published, because a repository holding its own version number has to be edited to
             * ship and the number it holds is a claim the catalog cannot check. That is deliberate
             * and it is not being undone here.
             *
             * The kernel is the exception, and it is forced rather than chosen: every other part
             * declares `kernel: ^0.15`, which names the kernel's **real** version. If the catalog
             * mints the kernel a label from its own sequence, that range is unsatisfiable and the
             * composition is refused — which is exactly what a fresh cluster hit, with eight parts
             * asking for `^0.15` against a kernel minted `0.1.0`.
             *
             * So the one part everything else coordinates on reports what it declares, and a caller
             * can pin it without being told a number it has no way to know.
             */
            version: z.string().optional(),
        })),
    }),
    rest: { method: 'POST', path: '/builder/imports' },
    /** The gate is the site's, and this one belongs behind `operator`: it names a repository to clone. */
    visibility: 'public',
    destructive: true,
    print: (o) => `${String(o.parts.length)} part(s) from ${o.repository} @ ${o.commit.slice(0, 12)}`,
});

/**
 * **Release a part: pull, mint a version, publish it, build it, say so.**
 *
 * The endpoint this whole rework exists for. What it replaces was six manual steps, and five of
 * them were bookkeeping:
 *
 * ```
 * edit mesh.json  →  commit  →  publish  →  build  →  compose  →  deploy
 * ```
 *
 * The first two are gone because **the version is minted here**, from what the catalog already
 * knows, rather than read from a file somebody had to edit. The last two are gone for a release
 * marked `rolling`, which recomposes and redeploys itself when this fires its event.
 *
 * ## Why it mints rather than reads
 *
 * A repository holding its own version number has to be edited to ship, and the number it holds is
 * a claim the catalog cannot check — the two disagree constantly, and the repository always loses,
 * because the catalog is what resolves. Minting removes the disagreement by removing one of the
 * copies. The label is derived: the highest already published, plus the requested bump.
 *
 * ## What it does not do
 *
 * It does not push. Nothing here writes to the repository — no version commit, no tag, no
 * dependency bump — because a build node that can write to a repository is a build node whose
 * credential can rewrite what it later builds. `dependencies` is *recorded* from the resolved
 * lockfile onto the version row instead, which is the fact worth keeping.
 */
export const releasePartContract = defineContract({
    domain: 'builder',
    action: 'release_part',
    description: 'Pull a part, mint the next version, publish it and build its artifact.',
    dependencies: [],
    requirements: { memory: 2048, preferData: true },
    inputSchema: z.object({
        part: z.string().min(1).describe('→ part.name'),
        /**
         * How far to move the label. `patch` is the honest default for the case this exists for —
         * a change being shipped to see it work — and anything larger is a claim about
         * compatibility that a machine should not be making on somebody's behalf.
         */
        bump: z.enum(['patch', 'minor', 'major']).default('patch'),
        /** Override the mint entirely. For a deliberate number — a 1.0.0 somebody means. */
        version: z.string().min(1).optional(),
        /** Which branch to cut from, when it is not the one on the part's declaration. */
        branch: z.string().min(1).optional(),
        /** Resolve, mint and report — publish nothing, build nothing. */
        dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
        part: z.string(),
        version: z.string(),
        commit: z.string(),
        /** True when this commit was already published, and the existing label was used. */
        existed: z.boolean(),
        artifactDigest: z.string().optional(),
        /** True when identical bytes were already built and nothing ran. */
        cached: z.boolean(),
    }),
    rest: { method: 'POST', path: '/builder/releases' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.part}@${o.version} ${o.commit.slice(0, 12)}${o.cached ? ' (cached)' : ''}`,
});

/**
 * Every part a repository declares, released together, in dependency order.
 *
 * Because a repository is not one part. mesh-core builds seven from a single commit, and releasing
 * them one at a time is the loop this is meant to end — worse, it has an order: a part is built
 * against a kernel range, so a kernel released after the parts that need it produces a set nobody
 * can compose until somebody notices and runs it again.
 *
 * Kernels first, then everything else. One commit, so every part in the answer is the same code.
 */
export const releaseRepoContract = defineContract({
    domain: 'builder',
    action: 'release_repo',
    description: 'Release every part declared from one repository, kernels first.',
    dependencies: [],
    requirements: { memory: 2048, preferData: true },
    inputSchema: z.object({
        repository: z.string().min(1),
        bump: z.enum(['patch', 'minor', 'major']).default('patch'),
        branch: z.string().min(1).optional(),
        dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
        repository: z.string(),
        released: z.array(z.object({
            part: z.string(),
            version: z.string(),
            commit: z.string(),
            artifactDigest: z.string().optional(),
            cached: z.boolean(),
        })),
        /**
         * Parts that could not be released, and why.
         *
         * Reported rather than thrown: seven parts should give seven answers, and stopping on the
         * first turns one call into seven.
         */
        failed: z.array(z.object({ part: z.string(), reason: z.string() })),
    }),
    rest: { method: 'POST', path: '/builder/repo-releases' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${String(o.released.length)} released, ${String(o.failed.length)} failed`,
});

/**
 * One artifact, by digest.
 *
 * **The question every serving node asks first.** A site's resolution names digests; a cdn node
 * turns one into a file list before it can answer anything, and it must not reach into the builder's
 * collection to do it. `artifact.find_one({ query: { digest } })` would work and would be wrong — it
 * makes a private collection part of another service's contract, so the day the builder changes how
 * it stores things, the cdn breaks.
 *
 * `public` means **may be exposed**, never *unauthenticated*: the gate is chosen per site. Worth
 * knowing before choosing one — a digest is unguessable, but this answers for *any* digest, so a
 * caller holding one learns that artifact's file names and sizes regardless of who owns it. The
 * bytes are a separate contract, and the cdn's own check that a site may only serve what it composed
 * is what actually holds the boundary.
 */
export const getArtifactContract = defineContract({
    domain: 'builder',
    action: 'get_artifact',
    description: 'Fetch one artifact by its content digest.',
    inputSchema: z.object({ digest: z.string().min(1) }),
    // The collection's own output shape rather than a hand-written copy, so a field added to
    // `ArtifactSchema` appears here and the two cannot drift.
    outputSchema: artifactCrud.get.outputSchema,
    rest: { method: 'GET', path: '/builder/artifacts/:digest' },
    visibility: 'public',
    print: (o) => `${o.digest} (${String(o.files.length)} files)`,
});

/**
 * **Where** to download one file of an artifact — not the file.
 *
 * The first version returned the bytes as base64 over the mesh, and that does not survive contact
 * with a real artifact. A kernel bundle is megabytes; base64 adds a third again; and every byte
 * would be JSON-encoded into a single broker message, held whole in memory at both ends, on a
 * transport built for control messages rather than for content. The failure mode is not slowness,
 * it is a frame that a transport refuses at some size nobody chose.
 *
 * So the contract hands back a URL and the caller fetches it over HTTP, streaming, in parallel, with
 * range requests and caching it did not have to invent. **The mesh answers questions; content moves
 * over HTTP.**
 *
 * The URL is stable for the life of the content because the digest *is* the content, so a caller may
 * cache the answer as long as it likes — and a node that already holds those bytes never asks.
 */
export const artifactBlobContract = defineContract({
    domain: 'builder',
    action: 'artifact_blob',
    description: 'Where to download one file of an artifact, by its content digest.',
    inputSchema: z.object({ digest: z.string().min(1) }),
    outputSchema: z.object({
        url: z.string().describe('Absolute, and safe to cache: a digest cannot come to mean other bytes'),
        size: z.number(),
    }),
    // Required by `defineContract`, and declaring one is not exposing one: a REST shape says how this
    // *would* be addressed, and whether any site puts it on the internet is that site's decision.
    rest: { method: 'GET', path: '/builder/blobs/:digest' },
    print: (o) => `${o.url} (${String(o.size)} bytes)`,
});

// ---------------------------------------------------------------------------- events

export const ArtifactPublishedSchema = z.object({
    digest: z.string(),
    partId: z.string(),
    kind: z.enum(['kernel', 'application', 'extension']),
    version: z.string(),
});
export type ArtifactPublished = z.infer<typeof ArtifactPublishedSchema>;

/**
 * A new artifact exists.
 *
 * The catalog listens and registers the version; nothing is deployed by it. A new build going live
 * on its own would make every site's composition change without anyone asking — which is the
 * difference between a registry and a deploy, and the reason a site names a version requirement
 * rather than following a branch.
 *
 * `scopedBy: 'global'`, and it follows from the collection above rather than being a separate call.
 * `artifactCrud` is already global on purpose — an artifact is addressed by the hash of its content,
 * so two organizations building identical source get one row, and pretending otherwise would store
 * the same bytes twice. An event about a globally-addressed thing is global for the same reason.
 *
 * What that leaks is a digest, a part id, a kind and a version — all of which `catalog.resolve`
 * already answers to anyone. The source behind it does not travel here.
 */
export const artifactPublishedEvent = defineEvent('builder.artifact_published', ArtifactPublishedSchema, {
    scopedBy: 'global',
});

export const PartReleasedSchema = z.object({
    /** Who released it. A rolling release only follows parts its own tenant published. */
    tenantId: z.string(),
    part: z.string(),
    kind: z.enum(['kernel', 'application', 'extension']),
    version: z.string(),
    commit: z.string(),
    /** Absent when the build produced nothing — a failure that still ended a release attempt. */
    digest: z.string().optional(),
});
export type PartReleased = z.infer<typeof PartReleasedSchema>;

/**
 * A part was released: pulled, published at a new label, and built.
 *
 * **This is what a rolling release listens to**, and it exists rather than reusing
 * `builder.artifact_published` for one reason that matters: that event fires only when the *bytes*
 * are new. Identical source bundles to an identical digest and publishes nothing, so a release
 * following `^0.2` would never hear about the version it should now resolve to. This fires whenever
 * a release completes; the recompose it triggers is a no-op when nothing actually moved, and a
 * redundant no-op is the right side of that trade.
 *
 * `scopedBy: 'tenantId'`, unlike the artifact event beside it. An artifact is content-addressed and
 * global — two organizations building identical source have built the same thing — but a *release*
 * is an act by somebody, and which parts an organization is shipping, at what cadence, is not
 * something the catalog publishes to everyone. The version itself is public via
 * `catalog.version_published`; the release cadence is not.
 */
export const partReleasedEvent = defineEvent('builder.part_released', PartReleasedSchema, {
    scopedBy: 'tenantId',
});
