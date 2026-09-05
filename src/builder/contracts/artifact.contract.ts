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
     * The consequence is a real invariant with nowhere to live yet: **two rows can claim the same
     * bytes**, which content addressing exists precisely to prevent. Until a collection can take a
     * natural key, `digest` needs a unique index and the writer needs to check — see
     * `spec/building.md`.
     */
    pluralPath: 'artifacts',
    // Reading and writing an artifact record touches no other domain. Publishing one does — it asks
    // the catalog to register a version — and that is `build_start`'s job, not a hooked create.
    dependencies: [],
});

export const buildCrud = defineCrud('build', BuildSchema, {
    pluralPath: 'builds',
    dependencies: [],
});

// ---------------------------------------------------------------------------- doing the work

export const buildStartContract = defineContract({
    domain: 'builder',
    action: 'build_start',
    description: 'Build the parts a repository declares, and publish each as its own artifact.',
    inputSchema: z.object({
        /**
         * A branch or tag is accepted here and resolved to a commit before a build record exists.
         * The record itself only ever holds a commit: a branch hashes to itself while the code moves
         * underneath it, so a cache keyed on one would serve a stale artifact indefinitely.
         */
        source: z.union([
            SourceRefSchema,
            z.object({
                kind: z.literal('git'),
                repository: z.string().min(1),
                ref: z.string().min(1),
                subdirectory: z.string().min(1).optional(),
            }).strict(),
        ]),
    }),
    outputSchema: z.object({
        /**
         * One per part the repository declares — a repository with a chrome extension and an
         * application produces two artifacts, and they are versioned and replaced separately from
         * then on. That is the whole point of building parts rather than sites.
         */
        builds: z.array(z.object({
            partId: z.string(),
            buildId: z.string(),
            state: z.string(),
            artifactDigest: z.string().optional(),
            /** True when an identical input hash was already built and nothing ran. */
            cached: z.boolean(),
        })),
    }),
    rest: { method: 'POST', path: '/builder/builds' },
    destructive: true,
    print: (o) => o.builds.map((b) => `${b.partId}: ${b.state}`).join(', '),
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
 */
export const artifactPublishedEvent = defineEvent('builder.artifact_published', ArtifactPublishedSchema);
