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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuilderService } from '../builder.service.js';
import { buildStartContract } from '../contracts/artifact.contract.js';
import { dependenciesFrom } from '../methods/lockfile.js';
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
    const part = await ctx.call('part.find_one', { query: { name: input.part } });
    if (part === null || part === undefined) {
        throw new ClientError(`No part named "${input.part}" is published.`, 'part_not_found', 404);
    }

    const version = await ctx.call('partVersion.find_one', {
        query: { partName: input.part, version: input.version },
    });
    if (version === null || version === undefined) {
        throw new ClientError(
            `${input.part} has no published version ${input.version}. A build takes an exact ` +
            `version, never a range — resolve it first.`,
            'version_not_found', 404,
        );
    }

    assertMayPublish(part.publisher, ctx);

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
                kind: part.kind,
                id: part.name,
                version: version.version,
                entry: version.entry,
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

        return { part: input.part, version: input.version, ...built };
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
