/**
 * `builder.release_part` — pull, mint, publish, build, announce.
 *
 * ```
 * part row + branch  →  an exact commit  →  a minted label  →  a published version  →  an artifact
 *                                                                                          ↓
 *                                                                          builder.part_released
 *                                                                                          ↓
 *                                                            every release marked `rolling`
 * ```
 *
 * **The endpoint that ends the six-step loop.** What it replaces was: edit `mesh.json` to bump a
 * number, commit, publish, build, compose, deploy — six steps run by hand for a one-line change,
 * five of them bookkeeping. The first two are gone because the label is minted here from what the
 * catalog already knows; the last two are gone for a rolling release, which reacts to the event
 * this fires.
 *
 * ## What it deliberately does not do
 *
 * **It does not write to the repository.** No version commit, no tag, no dependency bump pushed
 * back. A build node that can write to a repository is a build node whose credential can rewrite
 * what it later builds, and the fix for a stale dependency pin is not to hand a build server commit
 * access. What a build actually resolved is recorded on the version row instead.
 *
 * **It does not deploy.** A new artifact going live on its own would change every site's
 * composition without anyone asking, which is the difference between a registry and a deploy. A
 * site that *has* asked marks its release `rolling` — an explicit, revocable, per-release decision.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import { nextVersion } from '../../catalog/methods/semver.js';
import type { BuilderService } from '../builder.service.js';
import { releasePartContract } from '../contracts/artifact.contract.js';
import { resolveGitSource } from '../methods/source.js';

type Input = z.infer<typeof releasePartContract['inputSchema']>;
type Output = z.infer<typeof releasePartContract['outputSchema']>;

export async function builder_release_part(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = ctx.meta?.user?.tenant_id ?? ctx.meta?.tenant_id;
    if (caller === undefined || caller === '') {
        throw new ClientError(
            'Releasing a part clones a repository this node may hold a credential for and ' +
            'publishes what runs on hostnames resolving to it, so it requires an authenticated ' +
            'caller. This call carries none.',
            'caller_unknown', 401,
        );
    }

    const part = await ctx.call('part.find_one', { query: { name: input.part } });
    if (part === null || part === undefined) {
        throw new ClientError(`No part named "${input.part}".`, 'part_not_found', 404);
    }

    if (part.publisher !== caller) {
        // Not found, not forbidden: which organization publishes a part is not something an
        // unrelated caller gets to confirm by probing.
        throw new ClientError('No such part.', 'part_not_found', 404);
    }

    const declaration = part.declaration;
    if (declaration === undefined) {
        throw new ClientError(
            `"${input.part}" has no declaration, so there is nothing to build from. Import the ` +
            `repository (builder.import_repo) or declare it (catalog.declare) first.`,
            'declaration_missing', 409,
        );
    }

    /**
     * **A branch becomes a commit before anything else happens.**
     *
     * Everything downstream is keyed on it — the version row, the build's input hash, the artifact
     * digest — and a build keyed on `main` would answer from cache forever while the code moved
     * underneath it. That failure is a deploy that silently does nothing, found days later with
     * nothing in any log.
     */
    const branch = input.branch ?? declaration.branch;
    const source = await resolveGitSource({
        repository: part.repository,
        ref: branch,
        ...(declaration.subdirectory === undefined ? {} : { subdirectory: declaration.subdirectory }),
    });

    const published = await ctx.call('partVersion.find', {
        query: { partName: input.part }, limit: 500,
    });

    /**
     * A commit already published keeps the label it has — **unless the caller asked for one.**
     *
     * Releasing twice with nothing pushed in between is the ordinary case: somebody clicks the
     * button again, and minting a second label for identical code would fill the catalog with
     * numbers that mean nothing. So an existing row's label wins over a *minted* one. The build
     * still runs, because the artifact may be missing when the version is not — that is `gone`.
     *
     * It must not win over an *explicit* one, and it did until 2026-09-07. `input.version` sat
     * behind `already?.version` in the same `??` chain, so asking to relabel a published commit
     * was silently ignored: the caller got a success naming the old label, which is the worst
     * possible answer — it looks like the relabel happened.
     *
     * Found pinning the kernel. Its commit was published as `0.16.1` because the catalog's own
     * sequence had reached there, while every part declares `kernel: ^0.15` and means the kernel's
     * real version. Pinning `0.15.11` reported `0.16.1 (pinned)` and changed nothing, and the
     * composition kept resolving an older kernel that happened to satisfy the range.
     */
    const already = published.find((row) => row.commit === source.ref);
    const version = input.version
        ?? already?.version
        ?? nextVersion(published.map((row) => row.version), input.bump);

    if (input.dryRun === true) {
        return {
            part: input.part, version, commit: source.ref,
            existed: already !== undefined, cached: false,
        };
    }

    await ctx.call('catalog.publish', {
        name: input.part,
        kind: part.kind,
        repository: part.repository,
        publisher: caller,
        version,
        commit: source.ref,
        entry: declaration.entry,
        ...(declaration.subdirectory === undefined ? {} : { subdirectory: declaration.subdirectory }),
        ...(declaration.kernel === undefined ? {} : { kernel: declaration.kernel }),
        requires: declaration.requires,
    });

    /**
     * The build is a call, not a function.
     *
     * So it can land on a node that has the memory for it — `build_start` declares 2048MB and
     * refuses below it, which is how a 981MB box stopped taking builds and dropping off the mesh
     * mid-bundle. Releasing is cheap and can run anywhere; building is not, and the placement
     * decision belongs to the thing that knows the requirement.
     */
    const built = await ctx.call('builder.build_start', {
        part: input.part,
        version,
        commit: source.ref,
    });

    /**
     * **The event rolling releases wait for.**
     *
     * Not `builder.artifact_published`, which fires only when the bytes are new — identical source
     * bundles to an identical digest and publishes no event, so a rolling release listening to it
     * would silently never hear about a version it *should* re-resolve to. This fires every time a
     * release completes, and the recompose it triggers is a no-op when nothing moved, which is the
     * right way round: a redundant no-op beats a missed update.
     */
    ctx.emit('builder.part_released', {
        tenantId: caller,
        part: input.part,
        kind: part.kind,
        version,
        commit: source.ref,
        ...(built.artifactDigest === undefined ? {} : { digest: built.artifactDigest }),
    });

    ctx.logger.info(
        `[builder] released ${input.part}@${version} from ${branch} ` +
        `(${source.ref.slice(0, 12)})${built.cached ? ' — cached' : ''}`,
    );

    return {
        part: input.part,
        version,
        commit: source.ref,
        existed: already !== undefined,
        ...(built.artifactDigest === undefined ? {} : { artifactDigest: built.artifactDigest }),
        cached: built.cached,
    };
}
