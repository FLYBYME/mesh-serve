/**
 * `catalog.publish` — one version of a part.
 *
 * This is where `mesh.json` stops being a file. On first publish the descriptor becomes a `part`
 * row, and from then on **the collection is authoritative**: the repository can change what it
 * builds, but not what it *is*.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CatalogService } from '../catalog.service.js';
import { publishContract } from '../contracts/part.contract.js';
import { parse } from '../methods/semver.js';

type Input = z.infer<typeof publishContract['inputSchema']>;
type Output = z.infer<typeof publishContract['outputSchema']>;

export async function catalog_publish(
    this: CatalogService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = ctx.meta?.user?.tenant_id ?? ctx.meta?.tenant_id;
    if (caller === undefined || caller === '') {
        throw new ClientError(
            'Publishing a part changes what runs on hostnames resolving to it, so it requires ' +
            'an authenticated caller. This call carries none.',
            'caller_unknown', 401,
        );
    }

    if (input.publisher !== undefined && input.publisher !== caller) {
        // Asserted publisher does not match caller's verified identity.
        // Not found, not forbidden: which organization publishes a part is not something an
        // unrelated caller gets to confirm by probing. Matches builder.build_start.
        throw new ClientError('No such part.', 'part_not_found', 404);
    }

    // Refused here rather than at resolve time. An unparseable version sits in the catalog matching
    // no range, which is indistinguishable from never having been published at all.
    if (parse(input.version) === undefined) {
        throw new ClientError(
            `"${input.version}" is not a semantic version. Ranges cannot be resolved against it.`,
            'version_invalid', 400,
        );
    }

    const part = await upsertPart.call(this, input, ctx, caller);

    /**
     * **Found by commit, because the commit is what a row is.**
     *
     * It was found by `(partName, version)` until 2026-09-07, and everything that made publishing
     * painful followed from that one line: a label was an identity, so re-publishing one was a 409,
     * so the label had to be bumped before every publish, so a repository had to hold its own
     * version numbers, so `mesh.json` had to be edited to ship a one-line change — and the escape
     * hatch that made it survivable (`MESH_ALLOW_REPUBLISH`) mutated a published version in place,
     * which is the one thing the invariant existed to prevent. Both are gone.
     */
    const existing = await ctx.call('partVersion.find_one', {
        query: { partName: input.name, commit: input.commit },
    });

    if (existing !== null && existing !== undefined) {
        /**
         * **One commit builds one artifact per part**, so the entry cannot move under it.
         *
         * A repository that builds two entries at one commit is publishing two parts — which is
         * ordinary and is how mesh-core publishes seven from a single commit — and each of them
         * gets its own name and its own row. Changing `entry` on an existing row would instead mean
         * this row's `artifactDigest` describes bytes the row no longer claims to be, which is
         * exactly the silent-mismatch the digest exists to make impossible.
         */
        if (existing.entry !== input.entry || existing.subdirectory !== input.subdirectory) {
            throw new ClientError(
                `${input.name} is already published at commit ${input.commit.slice(0, 12)} from ` +
                `entry ${existing.entry}, and this publishes ${input.entry} from the same commit. ` +
                `One commit builds one artifact per part — a second entry is a second part, so ` +
                `publish it under its own name.`,
                'entry_changed', 409,
            );
        }

        /**
         * A relabel, and nothing else can have changed that matters to the bytes.
         *
         * `version` is a label now, so moving one is an ordinary write: `0.15.10` may come to mean a
         * commit that shipped as `0.15.9-rc1` this morning. What a *release* serves does not move
         * with it — a release pins digests — so this changes what a range will resolve to next time
         * somebody composes, which is the thing an operator is asking for when they do it.
         */
        const relabelled = existing.version !== input.version;

        await ctx.call('partVersion.update', {
            id: existing.id,
            ...(relabelled ? { version: input.version } : {}),
            /**
             * **Provenance, and it does not follow the part.**
             *
             * `part.repository` means *where new versions come from* and may move; this means
             * *where this commit came from* and cannot, because a rebuild is `git fetch
             * <repository> <commit>` and the new repository has never contained it. Written only
             * when the row has none — those rows predate the field and have always effectively
             * used the part's.
             */
            ...(existing.repository === undefined ? { repository: input.repository } : {}),
            ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
            ...(input.kernel === undefined ? {} : { kernel: input.kernel }),
            requires: input.requires ?? [],
            capabilities: input.capabilities ?? { needs: [], provides: [] },
            // `state` and `artifactDigest` are deliberately untouched. The bytes are a property of
            // the commit and the entry, both of which are the same — so a re-publish must never
            // send a built version back to `declared` and make every composition refuse it.
        });

        if (relabelled) {
            ctx.logger.info(
                `[catalog] ${input.name} ${existing.version} → ${input.version} ` +
                `(commit ${input.commit.slice(0, 12)})`,
            );
            ctx.emit('catalog.version_published', {
                partName: input.name, version: input.version, kind: input.kind, commit: input.commit,
            });
        }

        return { partId: part.id, versionId: existing.id, existed: true };
    }

    const created = await ctx.call('partVersion.create', {
        partName: input.name,
        version: input.version,
        commit: input.commit,
        // Stamped here, at the one moment the repository and the commit are known to belong
        // together. `part.repository` can move afterwards; this cannot.
        repository: input.repository,
        ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
        entry: input.entry,
        ...(input.subdirectory === undefined ? {} : { subdirectory: input.subdirectory }),
        ...(input.kernel === undefined ? {} : { kernel: input.kernel }),
        requires: input.requires ?? [],
        capabilities: input.capabilities ?? { needs: [], provides: [] },
        // Declared, not built. The row exists and is buildable, which is the point of it — a version
        // is a thing you can ask for before anybody has produced the bytes.
        state: 'declared',
        publishedAt: new Date(),
    });

    ctx.emit('catalog.version_published', {
        partName: input.name, version: input.version, kind: input.kind, commit: input.commit,
    });

    return { partId: part.id, versionId: created.id, existed: false };
}

/**
 * The part row, created on first publish.
 *
 * **Its identity is fixed then.** A repository whose `mesh.json` later says a different `kind` is
 * describing a different part, and is refused by name — not quietly overwritten, and not silently
 * duplicated. Same rule as version immutability, applied to the genesis object.
 *
 * `repository` and `description` may change, because they describe where the source is and what it
 * is for, neither of which is identity.
 */
async function upsertPart(
    this: CatalogService,
    input: Input,
    ctx: IServiceContext,
    caller: string,
): Promise<{ id: string }> {
    const found = await ctx.call('part.find_one', { query: { name: input.name } });

    if (found === null || found === undefined) {
        const created = await ctx.call('part.create', {
            name: input.name,
            kind: input.kind,
            repository: input.repository,
            publisher: caller,
            description: input.description ?? '',
            ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
            ...(input.license === undefined ? {} : { license: input.license }),
            ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
            ...(input.icon === undefined ? {} : { icon: input.icon }),
        });
        return { id: created.id };
    }

    if (found.kind !== input.kind) {
        throw new ClientError(
            `"${input.name}" is published as a ${found.kind} and this says ${input.kind}. ` +
            `A part's kind is its identity; publish it under a different name.`,
            'part_kind_changed', 409,
        );
    }

    if (found.publisher !== caller) {
        // Whoever writes a version changes what runs on every site naming this part.
        // Not found, not forbidden: which organization publishes a part is not something an
        // unrelated caller gets to confirm by probing. Matches builder.build_start.
        throw new ClientError('No such part.', 'part_not_found', 404);
    }

    /**
     * **Where the source is can move, and until now it could not.**
     *
     * The comment above has always said `repository` and `description` may change. Nothing wrote
     * them after `part.create`: this returned `found.id` and dropped both, so the first publish
     * decided a part's repository permanently.
     *
     * That is not cosmetic, because `build_start` reads `part.repository` — not the version's. A
     * part first published from a working copy on somebody's laptop would be built from that path
     * forever, on every node, at every version. Publishing a new version could not fix it; there
     * was no path that could. Found doing exactly that: `clock` and `notes` went into the catalog
     * pointing at `/home/ubuntu/code/mesh-demos` and stayed there through a republish from GitHub.
     *
     * Identity is still fixed — `kind` and `publisher` refuse above, and a version's commit can
     * never move. This is the other half of that same rule: **what a part *is* cannot change, and
     * where its source lives is not what it is.**
     */
    /**
     * Presentation follows the descriptor; identity does not.
     *
     * Everything here is *changed only when the descriptor says something different*, and a field
     * the descriptor omits is left alone rather than cleared. That matters for a mixed
     * publisher — a CLI that knows about `description` and not `icon` must not silently erase an
     * icon somebody set another way.
     */
    const changes: Record<string, unknown> = {};
    const follow = <T>(current: T, next: T | undefined, key: string): void => {
        if (next !== undefined && JSON.stringify(current) !== JSON.stringify(next)) {
            changes[key] = next;
        }
    };

    if (found.repository !== input.repository) changes['repository'] = input.repository;
    follow(found.description, input.description, 'description');
    follow(found.homepage, input.homepage, 'homepage');
    follow(found.license, input.license, 'license');
    follow(found.keywords, input.keywords, 'keywords');
    follow(found.icon, input.icon, 'icon');

    if (Object.keys(changes).length > 0) {
        await ctx.call('part.update', { id: found.id, ...changes });
    }

    return { id: found.id };
}
