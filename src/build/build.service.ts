/**
 * The `build` service: a repository becomes a release.
 *
 * `catalog` and `builder` were two domains. Catalog read and wrote only its own rows; builder read
 * catalog and wrote into it. **Builder is catalog's writer**, and they are one thing — so this is one
 * service, and the collections it writes are mounted separately for the reason in `../collection.ts`.
 *
 * Nothing here touches the database directly. Every read and write is `ctx.call` into a collection,
 * which is what makes the whole pipeline reachable from a terminal and from a browser identically.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    ClientError, ServiceModule, type IServiceContext, type ServiceActionHandler,
    type ToolContract, type z,
} from '@flybyme/mesh';

import {
    composeContract, deployContract, importRepositoryContract, releasePartContract,
    releaseRepositoryContract,
} from './contracts/build.contract.js';
import { bundlePart, FRAMEWORK } from './methods/bundle.js';
import { artifactDigest, canonical, digestOf, inputHash } from './methods/content.js';
import { fileBlobStore, type BlobStore } from './methods/blobs.js';
import { gitFetcher, resolveGitSource, type Fetcher } from './methods/source.js';
import { DESCRIPTOR_FILE, parseDescriptor } from './schema/descriptor.js';
import type { Pinned } from './schema/catalog.js';

export interface BuildServiceOptions {
    /** Where artifact bytes live. Defaults to `MESH_BLOB_ROOT`, then `./.artifacts`. */
    readonly blobRoot?: string;
    /** Injected so a test can build from a fixture directory without a network or a git remote. */
    readonly fetch?: Fetcher;
    readonly blobs?: BlobStore;
    readonly now?: () => number;
}

/**
 * The builder's own identity, in every input hash.
 *
 * **A different bundler is a different output**, so a cache keyed without this would serve an
 * artifact built by a version whose behaviour has since changed. Bumped by hand when the bundling
 * rules change, which is the only honest way to say *these outputs are not comparable*.
 */
const BUILDER_VERSION = 'mesh-serve/1';

export class BuildService extends ServiceModule {
    public readonly domain = 'build';

    private readonly blobs: BlobStore;
    private readonly fetch: Fetcher;
    private readonly now: () => number;

    constructor(options: BuildServiceOptions = {}) {
        super();

        const root = options.blobRoot ?? process.env['MESH_BLOB_ROOT'] ?? './.artifacts';
        this.blobs = options.blobs ?? fileBlobStore(root);
        this.fetch = options.fetch ?? gitFetcher;
        this.now = options.now ?? Date.now;

        this.mountTool(importRepositoryContract, this.importRepository);
        this.mountTool(releasePartContract, this.releasePart);
        this.mountTool(releaseRepositoryContract, this.releaseRepository);
        this.mountTool(composeContract, this.compose);
        this.mountTool(deployContract, this.deploy);
    }

    /**
     * Read a repository's descriptor and declare its parts.
     *
     * **Declares or updates, and publishes nothing.** Running it twice against the same commit
     * changes nothing, which is how you find out it is idempotent rather than by being told.
     */
    private readonly importRepository: ServiceHandler<typeof importRepositoryContract> = async (input, ctx) => {
        const repository = await ctx.call('repository.get', { id: input.repositoryId });
        const source = await resolveGitSource({
            repository: repository.url,
            ref: input.ref ?? repository.defaultBranch,
            ...(repository.subdirectory === undefined ? {} : { subdirectory: repository.subdirectory }),
        });

        const declared = await this.inWorkspace(source, async (root) => {
            const where = repository.subdirectory === undefined ? root : join(root, repository.subdirectory);
            const raw = await readFile(join(where, DESCRIPTOR_FILE), 'utf8').catch(() => {
                throw new ClientError(
                    `${repository.url} has no ${DESCRIPTOR_FILE}`
                    + `${repository.subdirectory === undefined ? '' : ` under ${repository.subdirectory}`}`
                    + ` at ${source.ref.slice(0, 8)}. That file is how a repository says what it publishes.`,
                );
            });

            return parseDescriptor(raw, repository.name);
        });

        const parts = [];
        for (const part of declared.parts) {
            const existing = await ctx.call('part.find', {
                query: { repositoryId: repository.id, name: part.id },
                limit: 1,
            });

            const fields = {
                repositoryId: repository.id,
                organizationId: repository.organizationId,
                name: part.id,
                kind: part.kind,
                entry: part.entry,
                // Names, not row ids. See `PartSchema.requiredParts`.
                requiredParts: part.requiredParts.map((required) => required.id),
                description: part.description,
                ...(part.import === undefined ? {} : { importAs: part.import }),
                ...(part.license === undefined ? {} : { license: part.license }),
            };

            const found = existing[0];
            const row = found === undefined
                ? await ctx.call('part.create', fields)
                : await ctx.call('part.update', { id: found.id, ...fields });

            parts.push({ partId: row.id, name: row.name, kind: row.kind, created: found === undefined });
        }

        await ctx.call('repository.update', { id: repository.id, importedAt: this.now() });

        return { repositoryId: repository.id, commit: source.ref, parts };
    };

    /**
     * Mint a version, build it, store the bytes.
     *
     * **Idempotent on the commit**, checked before any cloning: a part whose commit has not moved
     * returns its existing version. Without that, every deploy mints a number, and a version that
     * increments because somebody ran a command twice is not a version.
     */
    private readonly releasePart: ServiceHandler<typeof releasePartContract> = async (input, ctx) => {
        const part = await ctx.call('part.get', { id: input.partId });
        const repository = await ctx.call('repository.get', { id: part.repositoryId });

        const source = await resolveGitSource({
            repository: repository.url,
            ref: input.ref ?? repository.defaultBranch,
            ...(repository.subdirectory === undefined ? {} : { subdirectory: repository.subdirectory }),
        });

        const existing = await ctx.call('version.find', {
            query: { partId: part.id, commit: source.ref, state: 'built' },
            limit: 1,
        });

        const already = existing[0];
        if (already?.artifactDigest !== undefined) {
            const artifact = await ctx.call('artifact.find', { query: { digest: already.artifactDigest }, limit: 1 });
            const found = artifact[0];

            return {
                partId: part.id,
                versionId: already.id,
                version: already.version,
                commit: already.commit,
                digest: already.artifactDigest,
                files: found?.files.length ?? 0,
                totalSize: found?.totalSize ?? 0,
                built: false,
            };
        }

        /**
         * What this part imports from other parts, resolved from **their** declarations.
         *
         * A part names the parts it needs by id; each provider declares the specifier it is
         * importable as. So a part cannot mark something external by asserting a specifier — it can
         * only name a part, and the part decides what it is called.
         */
        const external = await this.externalsFor(ctx, part.repositoryId, part.name, part.requiredParts);

        const hash = inputHash({
            source,
            partId: part.name,
            entry: part.entry,
            kind: part.kind,
            external: [...external].sort(),
            builder: BUILDER_VERSION,
        });

        const bundled = await this.inWorkspace(source, async (root) => {
            const where = repository.subdirectory === undefined ? root : join(root, repository.subdirectory);
            return bundlePart(where, { kind: part.kind, id: part.name, entry: part.entry }, undefined, external);
        });

        const digest = artifactDigest(bundled.files);
        const totalSize = bundled.files.reduce((sum, file) => sum + file.size, 0);

        for (const [blobDigest, content] of bundled.blobs) {
            await this.blobs.put(blobDigest, content);
        }

        // The artifact row is written before the version points at it, so a version never names a
        // digest nothing describes. The reverse order leaves a dangling reference on a crash.
        const known = await ctx.call('artifact.find', { query: { digest }, limit: 1 });
        if (known[0] === undefined) {
            await ctx.call('artifact.create', {
                digest,
                files: [...bundled.files],
                totalSize,
                builtAt: this.now(),
                buildId: hash,
                declaration: {
                    kind: part.kind,
                    id: part.name,
                    version: 'pending',
                    entry: part.entry,
                    external: [...external].sort(),
                    builtAgainst: [],
                },
                state: 'available',
            });
        }

        const version = await this.mintVersion(ctx, part.id, part.organizationId, source.ref, digest);

        return {
            partId: part.id,
            versionId: version.id,
            version: version.version,
            commit: source.ref,
            digest,
            files: bundled.files.length,
            totalSize,
            built: true,
        };
    };

    /**
     * Release every part a repository declares, kernels first.
     *
     * **A failure is collected, not thrown.** A repository of eight parts where the third fails
     * should still say what happened to the other five, because the useful question is *what is
     * broken* rather than *what broke first*.
     */
    private readonly releaseRepository: ServiceHandler<typeof releaseRepositoryContract> = async (input, ctx) => {
        const parts = await ctx.call('part.find', { query: { repositoryId: input.repositoryId }, limit: 200 });

        // Kernels first: everything else is bundled against one, so a kernel that does not exist yet
        // is a build nothing can check.
        const ordered = [...parts].sort((a, b) => rank(a.kind) - rank(b.kind));

        const released = [];
        const failed = [];

        for (const part of ordered) {
            try {
                const result = await ctx.call('build.release_part', {
                    partId: part.id,
                    ...(input.ref === undefined ? {} : { ref: input.ref }),
                });
                released.push({
                    name: part.name,
                    version: result.version,
                    digest: result.digest,
                    built: result.built,
                });
            } catch (error) {
                failed.push({ name: part.name, error: error instanceof Error ? error.message : String(error) });
            }
        }

        return { repositoryId: input.repositoryId, released, failed };
    };

    /**
     * Resolve versions into a release.
     *
     * **This is where a composition is refused.** A part with no built version, or a part whose
     * `requiredParts` are not in the release, fails here — the failure moves from a blank page to a
     * build, which is the whole point of composing at all.
     */
    private readonly compose: ServiceHandler<typeof composeContract> = async (input, ctx) => {
        const kernel = await this.pin(ctx, input.kernelPartId);
        if (kernel.kind !== 'kernel') {
            throw new ClientError(
                `"${kernel.pinned.name}" is an ${kernel.kind}, not a kernel. A release has exactly `
                + `one kernel and every other part is bundled against it.`,
            );
        }

        const pinned: Pinned[] = [];
        const byPartId = new Map<string, Pinned>([[kernel.pinned.partId, kernel.pinned]]);

        for (const partId of input.partIds) {
            if (partId === input.kernelPartId) continue;
            const resolved = await this.pin(ctx, partId);
            pinned.push(resolved.pinned);
            byPartId.set(partId, resolved.pinned);
        }

        /**
         * **Every `requiredParts` entry has to be in the release**, checked here rather than hoped
         * for. A part importing a specifier the page's import map will not carry is a page that
         * fails on load with a module resolution error — in a browser, at the worst moment, having
         * passed every build.
         */
        for (const partId of [input.kernelPartId, ...input.partIds]) {
            const part = await ctx.call('part.get', { id: partId });

            for (const name of part.requiredParts) {
                const provider = await this.partNamed(ctx, part.repositoryId, name);
                if (provider !== undefined && byPartId.has(provider.id)) continue;

                throw new ClientError(
                    `"${part.name}" requires "${name}", which this release does not compose. Add it, `
                    + `or the page will fail to resolve the import in a browser — after passing every `
                    + `build.`,
                );
            }
        }

        /**
         * The hash is over the contents, so composing the same parts twice is the same release —
         * and `canonical` sorts keys, so two compositions that mean the same thing hash the same
         * whatever order the caller listed them in.
         */
        const hash = digestOf(canonical({
            kernel: kernel.pinned,
            parts: [...pinned].sort((a, b) => a.partId.localeCompare(b.partId)),
        }));

        const existing = await ctx.call('release.find', { query: { hash }, limit: 1 });
        const found = existing[0];
        if (found !== undefined) {
            return {
                releaseId: found.id,
                hash,
                kernel: found.kernel,
                parts: found.parts,
                existing: true,
            };
        }

        const scope = scopeOf(ctx);
        const release = await ctx.call('release.create', {
            organizationId: scope,
            hash,
            name: input.name,
            kernel: kernel.pinned,
            parts: pinned,
            composedAt: this.now(),
        });

        return { releaseId: release.id, hash, kernel: kernel.pinned, parts: pinned, existing: false };
    };

    /** Point a hostname at a release. The act a rollback repeats with an earlier row. */
    private readonly deploy: ServiceHandler<typeof deployContract> = async (input, ctx) => {
        const release = await ctx.call('release.get', { id: input.releaseId });

        const sites = await ctx.call('site.find', { query: { host: input.host }, limit: 1 });
        const site = sites[0];
        if (site === undefined) throw new ClientError(`No site answers on "${input.host}".`);

        /**
         * **A site may only serve its own organization's release.**
         *
         * Checked here because this is the only contract that joins the two, and because the
         * alternative — one tenant pointing their hostname at another's build — is the single worst
         * thing this collection could allow.
         */
        if (site.organizationId !== release.organizationId) {
            throw new ClientError(
                `"${input.host}" belongs to a different organization from that release. A site serves `
                + `its own organization's releases.`,
            );
        }

        const previous = site.releaseId;
        await ctx.call('site.update', { id: site.id, releaseId: release.id });

        return {
            host: site.host,
            releaseId: release.id,
            hash: release.hash,
            ...(previous === undefined ? {} : { previousReleaseId: previous }),
        };
    };

    // ------------------------------------------------------------------ the work behind them

    /**
     * A workspace the builder chose, destroyed whichever way the build goes.
     *
     * **A caller never learns where it was**, which is the whole of *the code need not be local to
     * the server*. The cleanup is in a `finally` because a failed build leaves a checkout behind
     * otherwise, and a disk that fills up over a week of failures is a node that stops for a reason
     * nobody connects to builds.
     */
    private async inWorkspace<T>(
        source: Awaited<ReturnType<typeof resolveGitSource>>,
        work: (root: string) => Promise<T>,
    ): Promise<T> {
        const root = await mkdtemp(join(tmpdir(), 'mesh-build-'));
        try {
            await this.fetch(source, root);
            return await work(root);
        } finally {
            await rm(root, { recursive: true, force: true }).catch(() => {
                // A workspace that will not delete is worth neither failing a successful build nor
                // hiding: it is the node's problem, and the build's result is already correct.
            });
        }
    }

    /**
     * The specifiers a part's `requiredParts` are importable as.
     *
     * **Resolved from the provider's own declaration**, never from the requiring part: a part names
     * a part, and the part it names decides what it is called. A part that could assert a specifier
     * could mark anything external and ship a bundle missing the code it claimed to import.
     */
    private async externalsFor(
        ctx: IServiceContext,
        repositoryId: string,
        partName: string,
        requiredParts: readonly string[],
    ): Promise<string[]> {
        const specifiers: string[] = [];

        for (const name of requiredParts) {
            const provider = await this.partNamed(ctx, repositoryId, name);
            if (provider === undefined) {
                throw new ClientError(
                    `"${partName}" requires "${name}", which its repository does not declare. `
                    + `A required part is named by its id in the same descriptor.`,
                );
            }
            if (provider.importAs === undefined) {
                throw new ClientError(
                    `"${partName}" requires "${name}", but "${name}" declares no "import" specifier — `
                    + `so there is no name to mark external, and bundling would inline it. Add one to `
                    + `its descriptor.`,
                );
            }
            specifiers.push(provider.importAs);
        }

        return specifiers;
    }

    /** One part of a repository, by the name its descriptor gave it. */
    private async partNamed(
        ctx: IServiceContext,
        repositoryId: string,
        name: string,
    ): Promise<{ id: string; name: string; importAs?: string } | undefined> {
        const found = await ctx.call('part.find', { query: { repositoryId, name }, limit: 1 });
        return found[0];
    }

    /**
     * The next version number for a part.
     *
     * **Minted, never declared.** Monotonic per part, and the count is taken from what exists rather
     * than from a counter somebody could reset.
     */
    private async mintVersion(
        ctx: IServiceContext,
        partId: string,
        organizationId: string,
        commit: string,
        digest: string,
    ): Promise<{ id: string; version: string }> {
        const published = await ctx.call('version.count', { query: { partId } });
        const version = `0.0.${String(published + 1)}`;

        const row = await ctx.call('version.create', {
            partId,
            organizationId,
            version,
            commit,
            artifactDigest: digest,
            state: 'built',
            publishedAt: this.now(),
        });

        return { id: row.id, version: row.version };
    }

    /** A part's newest built version, as a pin. */
    private async pin(
        ctx: IServiceContext,
        partId: string,
    ): Promise<{ pinned: Pinned; kind: string }> {
        const part = await ctx.call('part.get', { id: partId });

        const versions = await ctx.call('version.find', {
            query: { partId, state: 'built' },
            sort: '-publishedAt',
            limit: 1,
        });

        const newest = versions[0];
        if (newest?.artifactDigest === undefined) {
            throw new ClientError(
                `"${part.name}" has no built version. Release it before composing it into anything.`,
            );
        }

        return {
            kind: part.kind,
            pinned: {
                partId: part.id,
                name: part.name,
                version: newest.version,
                digest: newest.artifactDigest,
                ...(part.importAs === undefined ? {} : { importAs: part.importAs }),
            },
        };
    }
}

/** Kernels first. An application is composed, an extension is added; neither is built against. */
const rank = (kind: string): number => (kind === 'kernel' ? 0 : kind === 'extension' ? 1 : 2);

/**
 * The organization this call runs in, or a refusal.
 *
 * Resolved by the gate from the caller's memberships and never supplied by the request
 * (`spec/identity.md` §8). Read through `IMeshMeta` rather than cast.
 */
function scopeOf(ctx: IServiceContext): string {
    const scope = ctx.meta?.user?.tenant_id;
    if (typeof scope !== 'string' || scope === '') {
        throw new ClientError(
            'This needs an organization, and none was resolved. An account in several must name one.',
        );
    }
    return scope;
}

type ServiceHandler<C extends ToolContract<z.ZodTypeAny, z.ZodTypeAny>> =
    ServiceActionHandler<z.infer<C['inputSchema']>, z.infer<C['outputSchema']>>;

export { FRAMEWORK };
