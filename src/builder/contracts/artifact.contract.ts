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
    // The digest *is* the identity. An invented id would mean two records could claim the same
    // bytes, and content addressing exists precisely so that they cannot.
    idField: 'digest',
    pluralPath: 'artifacts',
    // Reading and writing an artifact record touches no other domain. Publishing one does — it asks
    // the catalog to register a version — and that is `build_start`'s job, not a hooked create.
    dependencies: [],
});

export const buildCrud = defineCrud('build', BuildSchema, {
    idField: 'id',
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
 * The bytes of one file.
 *
 * Base64 over the mesh, and the only way content leaves the builder. **One hop per file per node**:
 * a serving node caches by digest, and a digest can never come to mean different bytes, so a cold
 * cache is slower rather than wrong.
 *
 * `internal`, and it must stay that way. Blobs are addressed by hash with no tenant on them — the
 * check that a site may serve a given artifact lives in the cdn, against that site's own
 * composition. Exposing this would route around it.
 */
export const artifactBlobContract = defineContract({
    domain: 'builder',
    action: 'artifact_blob',
    description: 'Fetch one file of an artifact by its content digest.',
    inputSchema: z.object({ digest: z.string().min(1) }),
    outputSchema: z.object({
        content: z.string().optional().describe('base64; absent when this node does not hold it'),
        size: z.number(),
    }),
    // Required by `defineContract`, and declaring one is not exposing one: a REST shape says how this
    // *would* be addressed, and whether any site puts it on the internet is that site's decision.
    rest: { method: 'GET', path: '/builder/blobs/:digest' },
    print: (o) => (o.content === undefined ? 'not held' : `${String(o.size)} bytes`),
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
