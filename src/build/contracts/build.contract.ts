/**
 * Building: the collections, and the four verbs that move a repository to a release.
 *
 * `spec/building.md` §3. The pipeline is **register, import, release, compose, deploy** — five steps
 * because each produces something the next one names, and because a rollback is picking a row from a
 * list rather than rebuilding anything.
 */

import { defineContract, defineCrud, type ToolContract, z } from '@flybyme/mesh';

import { ArtifactSchema } from '../schema/artifact.js';
import { PinnedSchema, PartSchema, ReleaseSchema, RepositorySchema, VersionSchema } from '../schema/catalog.js';

// ---------------------------------------------------------------------------- collections

/**
 * Repositories, owned by an organization.
 *
 * **`name` is unique within the organization, not globally** — one word, and it is the whole fix for
 * the part namespace. Scoped, because unlike `site` nothing resolves a repository before there is a
 * caller: it is read by a build, and a build has one.
 */
export const repositoryCrud = defineCrud('repository', RepositorySchema, {
    pluralPath: 'repositories',
    scopedBy: 'organizationId',
    unique: [{ fields: 'name', scope: 'scoped' }],
    visibility: { find: 'public', get: 'public', count: 'public', create: 'public', delete: 'public' },
    dependencies: [],
});

export type StoredRepository = z.infer<typeof repositoryCrud.outputSchema>;

/**
 * Parts.
 *
 * Scoped by organization and unique by `(repositoryId, name)`. Two organizations may each have a
 * part called `kernel`, and so may two repositories in one organization — which is what the previous
 * global namespace refused outright.
 */
export const partCrud = defineCrud('part', PartSchema, {
    pluralPath: 'parts',
    scopedBy: 'organizationId',
    unique: [{ fields: ['repositoryId', 'name'], scope: 'scoped' }],
    visibility: { find: 'public', get: 'public', count: 'public' },
    dependencies: [],
});

export type StoredPart = z.infer<typeof partCrud.outputSchema>;

/** Versions. Unique by `(partId, version)`, because a version number may not be spent twice. */
export const versionCrud = defineCrud('version', VersionSchema, {
    pluralPath: 'versions',
    scopedBy: 'organizationId',
    unique: [{ fields: ['partId', 'version'], scope: 'scoped' }],
    visibility: { find: 'public', get: 'public', count: 'public' },
    dependencies: [],
});

export type StoredVersion = z.infer<typeof versionCrud.outputSchema>;

/**
 * Artifacts. **Not scoped, and that is deliberate.**
 *
 * An artifact is named by the hash of its contents, so two organizations that built the same bytes
 * produce the same digest and there is nothing to keep apart — scoping it would mean storing the
 * same megabyte twice to preserve a boundary the content itself does not have. What is scoped is the
 * *version* that points at it, which is what says whose build it was.
 *
 * Reads are by digest and a digest is unguessable, which is the same argument content-addressed
 * storage always makes.
 */
export const artifactCrud = defineCrud('artifact', ArtifactSchema, {
    pluralPath: 'artifacts',
    idField: 'id',
    unique: [{ fields: 'digest', scope: 'global' }],
    visibility: { find: 'public', get: 'public', count: 'public' },
    dependencies: [],
});

export type StoredArtifact = z.infer<typeof artifactCrud.outputSchema>;

/** Releases. Unique by hash within the organization, so composing twice is the same row. */
export const releaseCrud = defineCrud('release', ReleaseSchema, {
    pluralPath: 'releases',
    scopedBy: 'organizationId',
    unique: [{ fields: 'hash', scope: 'scoped' }],
    visibility: { find: 'public', get: 'public', count: 'public' },
    dependencies: [],
});

export type StoredRelease = z.infer<typeof releaseCrud.outputSchema>;

// ---------------------------------------------------------------------------- the verbs

/**
 * Read a repository's descriptor and declare the parts it describes.
 *
 * **Separate from registering it**, because a repository can be known before it is read: an operator
 * adds one, sees it in a list, and imports it later. That is why a repository is a row rather than a
 * string on a part.
 *
 * **Publishes nothing.** Importing creates or updates part rows; minting a version is `release_part`.
 */
export const importRepositoryContract = defineContract({
    domain: 'build',
    action: 'import_repository',
    description: "Read a repository's descriptor and declare the parts it describes.",
    inputSchema: z.object({
        repositoryId: z.string().min(1),
        /** Defaults to the repository's own default branch. */
        ref: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        repositoryId: z.string(),
        commit: z.string(),
        parts: z.array(z.object({
            partId: z.string(),
            name: z.string(),
            kind: z.string(),
            created: z.boolean().describe('False when this import updated an existing part'),
        })),
    }),
    rest: { method: 'POST', path: '/repositories/:repositoryId/import' },
    visibility: 'public',
    destructive: true,
    /**
     * Cloning takes longer than a question. The broker's ten-second default is right for a read and
     * wrong for work — `spec/building.md` §7, where a caller timed out while the builder carried on
     * and finished correctly, which is the most confusing pair of outcomes available.
     */
    timeout: 120_000,
    print: (o) => `${String(o.parts.length)} part(s) at ${o.commit.slice(0, 8)}`,
});

/**
 * Mint the next version of one part, build it, and record the artifact.
 *
 * **Idempotent on the commit.** Releasing a part whose commit has not moved returns the existing
 * version rather than minting another — a version number that can be spent twice is a number that
 * means nothing.
 */
export const releasePartContract = defineContract({
    domain: 'build',
    action: 'release_part',
    description: 'Mint the next version of a part, build it, and record the artifact.',
    inputSchema: z.object({
        partId: z.string().min(1),
        ref: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        partId: z.string(),
        versionId: z.string(),
        version: z.string(),
        commit: z.string(),
        digest: z.string(),
        files: z.number().int(),
        totalSize: z.number().int(),
        /** False when the commit had not moved and the existing version was returned. */
        built: z.boolean(),
    }),
    rest: { method: 'POST', path: '/parts/:partId/release' },
    visibility: 'public',
    destructive: true,
    timeout: 300_000,
    print: (o) => `${o.version} — ${o.digest.slice(0, 16)} (${String(o.files)} files)`,
});

/**
 * Release every part in a repository, kernels first.
 *
 * Kernels first because a part is bundled against one, so a kernel that does not exist yet is a
 * build that cannot be checked.
 */
export const releaseRepositoryContract = defineContract({
    domain: 'build',
    action: 'release_repository',
    description: 'Release every part a repository declares, kernels first.',
    inputSchema: z.object({
        repositoryId: z.string().min(1),
        ref: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        repositoryId: z.string(),
        released: z.array(z.object({
            name: z.string(),
            version: z.string(),
            digest: z.string(),
            built: z.boolean(),
        })),
        /**
         * Parts that failed, with why — rather than one thrown error for the first.
         *
         * A repository of eight parts where the third fails should still tell you about the other
         * five, because the useful question is *what is broken* and not *what broke first*.
         */
        failed: z.array(z.object({ name: z.string(), error: z.string() })).default([]),
    }),
    rest: { method: 'POST', path: '/repositories/:repositoryId/release' },
    visibility: 'public',
    destructive: true,
    timeout: 600_000,
    print: (o) => `${String(o.released.length)} released, ${String(o.failed.length)} failed`,
});

/**
 * Resolve versions into a release.
 *
 * **This is where a composition is refused**, and it is the whole reason composing is a separate act
 * from deploying: a release naming a part that has no artifact, or a part whose `requiredParts` are
 * not in the release, fails here rather than in somebody's browser.
 */
export const composeContract = defineContract({
    domain: 'release',
    action: 'compose',
    description: 'Resolve versions into a release, and record what holds together.',
    inputSchema: z.object({
        name: z.string().default(''),
        /** The kernel, by part id. Exactly one, and everything else is built against it. */
        kernelPartId: z.string().min(1),
        /** Every other part, by id. Each resolves to its newest built version. */
        partIds: z.array(z.string().min(1)).default([]),
    }),
    outputSchema: z.object({
        releaseId: z.string(),
        hash: z.string(),
        kernel: PinnedSchema,
        parts: z.array(PinnedSchema),
        /** True when an identical release already existed, so nothing was written. */
        existing: z.boolean(),
    }),
    rest: { method: 'POST', path: '/releases/compose' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.hash.slice(0, 16)} — ${String(o.parts.length + 1)} part(s)`,
});

/**
 * Point a hostname at a release.
 *
 * **A separate act from composing, and that separation is what makes a rollback cheap**: deploying
 * an earlier release is picking a row from a list, with nothing rebuilt and nothing fetched.
 */
export const deployContract = defineContract({
    domain: 'release',
    action: 'deploy',
    description: 'Point a hostname at a release.',
    inputSchema: z.object({
        host: z.string().min(1),
        releaseId: z.string().min(1),
    }),
    outputSchema: z.object({
        host: z.string(),
        releaseId: z.string(),
        hash: z.string(),
        /** What it was serving before, so a rollback does not need the history read separately. */
        previousReleaseId: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/sites/:host/deploy' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.host} -> ${o.hash.slice(0, 16)}`,
});

export const allBuildContracts: readonly ToolContract<z.ZodTypeAny, z.ZodTypeAny>[] = [
    importRepositoryContract,
    releasePartContract,
    releaseRepositoryContract,
    composeContract,
    deployContract,
];
