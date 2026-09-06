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
    // Refused here rather than at resolve time. An unparseable version sits in the catalog matching
    // no range, which is indistinguishable from never having been published at all.
    if (parse(input.version) === undefined) {
        throw new ClientError(
            `"${input.version}" is not a semantic version. Ranges cannot be resolved against it.`,
            'version_invalid', 400,
        );
    }

    const part = await upsertPart.call(this, input, ctx);
    const existing = await ctx.call('partVersion.find_one', {
        query: { partName: input.name, version: input.version },
    });

    if (existing !== null && existing !== undefined) {
        // Idempotent when it is the same commit: a CI job that runs twice is not an error.
        if (existing.commit === input.commit) {
            return { partId: part.id, versionId: existing.id, existed: true };
        }

        // **The invariant.** Without it, `^1.0` resolves to bytes that changed underneath it and
        // every site pinning that range silently gets different code. Both commits are named,
        // because the useful question is which one is the impostor.
        throw new ClientError(
            `${input.name}@${input.version} is already published from commit ${existing.commit}, ` +
            `and cannot be republished from ${input.commit}. A version is immutable: publish a new ` +
            `version instead.`,
            'version_immutable', 409,
        );
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
): Promise<{ id: string }> {
    const found = await ctx.call('part.find_one', { query: { name: input.name } });

    if (found === null || found === undefined) {
        const created = await ctx.call('part.create', {
            name: input.name,
            kind: input.kind,
            repository: input.repository,
            publisher: input.publisher,
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

    if (found.publisher !== input.publisher) {
        // Whoever writes a version changes what runs on every site naming this part.
        throw new ClientError(
            `"${input.name}" belongs to another publisher.`,
            'part_not_yours', 403,
        );
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
