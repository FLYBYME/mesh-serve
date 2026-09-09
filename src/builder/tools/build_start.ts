/**
 * `builder.build_start` — one published version of a part, into its artifact.
 *
 * ```
 * catalog: part + version  →  a workspace this builder owns  →  bytes  →  one artifact
 * ```
 *
 * Nothing outside ever gets a path. The workspace is created, used and destroyed here, and the only
 * thing that leaves is content plus a digest — which is what makes *"the code need not be local to
 * the server"* true rather than aspirational.
 *
 * ## The input is a part, not a repository
 *
 * It took a `SourceRef` until a credential existed, and then that shape was a hole: the caller named
 * the repository, so a node holding a token that can read a private one would clone it for whoever
 * asked and publish the result as a fetchable artifact.
 *
 * Everything a build needs is already in the catalog — repository, commit, entry, and who may
 * publish — so the caller names a part and the builder looks the rest up. **`mesh.json` is not read
 * here at all.** It seeded the catalog at publish time and the collection is authoritative from then
 * on, which is also why a repository editing its descriptor cannot change what an already-published
 * version builds.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuilderService } from '../builder.service.js';
import { buildStartContract } from '../contracts/artifact.contract.js';
import { dependenciesFrom } from '../methods/lockfile.js';
import { getNodeMemoryMB } from '../methods/placement.js';
import { publishPart } from '../methods/publish.js';
import { describeSource } from '../methods/source.js';
import type { SourceRef } from '../schema/build.js';

type Input = z.infer<typeof buildStartContract['inputSchema']>;
type Output = z.infer<typeof buildStartContract['outputSchema']>;

export async function builder_build_start(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    // Enforce contract placement requirements: decline work this node cannot do
    const reqs = buildStartContract.requirements;
    const nodeMemMB = getNodeMemoryMB();
    if (reqs?.memory !== undefined && nodeMemMB < reqs.memory) {
        throw new ClientError(
            `Node "${os.hostname()}" has ${nodeMemMB}MB memory, declining build for ` +
            `"${input.part}@${input.version}" (requires ${reqs.memory}MB).`,
            'insufficient_memory',
            507,
        );
    }

    const part = await ctx.call('part.find_one', { query: { name: input.part } });
    if (part === null || part === undefined) {
        throw new ClientError(`No part named "${input.part}" is published.`, 'part_not_found', 404);
    }

    /**
     * **The builder builds code, and an agent part is a declaration.**
     *
     * It has no entry — `catalog.declare` refuses one — so there is nothing to fetch and nothing to
     * bundle. `PublishInput.part.kind` names only the buildable kinds on purpose, and this is the
     * guard that makes that narrowing true rather than merely asserted.
     *
     * A `release_part` on one is refused earlier and with the same reasoning; this catches a
     * `build_start` reached directly, which is the path a fleet or a rebuild-on-eviction takes.
     */
    if (part.kind === 'agent') {
        throw new ClientError(
            `"${input.part}" is an agent part: it declares which contracts each role may call and `
            + 'has no source. There is nothing to build.',
            'agent_not_buildable', 400,
        );
    }
    const buildableKind = part.kind;

    /**
     * A commit if the caller has one, otherwise the newest row carrying that label.
     *
     * `version` is a label rather than an identity since 2026-09-07, so two rows may carry `0.2.4`
     * and a build has to choose. Newest is what a person means when they type one — and a caller
     * that cares which bytes it gets names the commit, which is exact.
     */
    const candidates = input.commit === undefined
        ? await ctx.call('partVersion.find', {
            query: { partName: input.part, version: input.version }, limit: 50,
        })
        : await ctx.call('partVersion.find', {
            query: { partName: input.part, commit: input.commit }, limit: 1,
        });

    const version = [...candidates]
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0];

    if (version === undefined) {
        throw new ClientError(
            input.commit === undefined
                ? `${input.part} has no published version ${input.version}. A build takes an exact ` +
                  `version, never a range — resolve it first.`
                : `${input.part} has no version published from commit ${input.commit.slice(0, 12)}.`,
            'version_not_found', 404,
        );
    }

    assertMayPublish(part.publisher, ctx);

    /**
     * `entry` is optional on a version *because* of the agent kind, and this narrows it back.
     *
     * Read from the version rather than the part's declaration: a build is keyed on the row, and the
     * declaration may have moved since it was published. Unreachable for a row this repository
     * wrote — `catalog.declare` and the agent guard above both refuse the states that produce it —
     * so this is the second line for a row that arrived some other way, failing here with a sentence
     * rather than inside esbuild with a missing entry point.
     */
    const versionEntry = version.entry;
    if (versionEntry === undefined) {
        throw new ClientError(
            `${input.part}@${version.version} records no entry, so there is nothing to bundle.`,
            'entry_missing', 409,
        );
    }

    // Built from the catalog, so there is no field a caller could have used to name a repository.
    // The commit is already exact: `catalog.publish` refuses anything else, which is what makes an
    // input hash meaningful and a rebuild reproducible.
    const source: SourceRef = {
        kind: 'git',
        /**
         * **The version's own repository, falling back to the part's.**
         *
         * These were one field until 2026-09-06, taken from the part — so a part that moved
         * repositories took every one of its published versions with it, and each of them then
         * named a commit the new repository has never contained. The rebuild path is the whole
         * durability story (`gone` → rebuild), so that failure would surface at the worst moment,
         * on an artifact that had been evicted rather than at publish time.
         *
         * The fallback is for rows published before the field existed. They have always effectively
         * used the part's repository, and for them it is still correct.
         */
        repository: version.repository ?? part.repository,
        ref: version.commit,
        ...(version.subdirectory === undefined ? {} : { subdirectory: version.subdirectory }),
    };

    // Ours, and destroyed in the `finally`. A caller never learns where it was.
    const workspace = await mkdtemp(join(tmpdir(), 'mesh-build-'));

    try {
        ctx.logger.info(`[builder] ${input.part}@${input.version}: fetching ${describeSource(source)}`);
        await this.fetch(source, workspace);

        const root = source.subdirectory === undefined
            ? workspace
            : join(workspace, source.subdirectory);

        // The one thing still read from the tree rather than the catalog, and it has to be: it
        // records what the author actually had installed when they typechecked, which is a fact
        // about the commit and not about the declaration.
        const builtAgainst = dependenciesFrom(
            await readFile(join(root, 'package-lock.json'), 'utf8').catch(() => undefined),
        );

        const built = await publishPart(this, {
            root,
            source,
            part: {
                kind: buildableKind,
                id: part.name,
                version: version.version,
                entry: versionEntry,
            },
            ...(version.kernel === undefined ? {} : { kernel: version.kernel }),
            requires: version.requires,
            requiredParts: version.requiredParts,
            builtAgainst,
        }, ctx);

        if (built.artifactDigest !== undefined) {
            // The version stops being `declared`. Written after the artifact exists, never before:
            // a row saying `built` while the bytes are still being produced is a row something else
            // will act on and find nothing.
            await ctx.call('partVersion.update', {
                id: version.id, state: 'built', artifactDigest: built.artifactDigest,
            });
        }

        // The row's own label, not the caller's: a build named by commit may carry a different one,
        // and the answer should say what was actually built.
        return { part: input.part, version: version.version, ...built };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

/**
 * May this caller build for this part?
 *
 * The publisher owns the repository the builder is about to clone with whatever credential it holds,
 * so this is the check that stands between a token and every repository that token can read.
 *
 * A call with no caller is refused rather than allowed. An unauthenticated build is a build somebody
 * arranged to be unauthenticated, and defaulting to *allow* here is how the check comes to be
 * decorative.
 */
function assertMayPublish(publisher: string, ctx: IServiceContext): void {
    const meta = ctx.meta as { user?: { tenant_id?: string }; tenant_id?: string } | undefined;
    const caller = meta?.user?.tenant_id ?? meta?.tenant_id;

    if (caller === undefined) {
        throw new ClientError(
            'A build names a part whose repository this node may hold a credential for, so it ' +
            'requires a caller. This call carries none.',
            'caller_unknown', 401,
        );
    }

    if (caller !== publisher) {
        // Not found, not forbidden: which organization publishes a part is not something an
        // unrelated caller gets to confirm by probing.
        throw new ClientError('No such part.', 'part_not_found', 404);
    }
}
