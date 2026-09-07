/**
 * `builder.import_repo` — a repository's descriptor, once, into part rows.
 *
 * ```
 * mesh.json  →  catalog.declare, once per part  →  the catalog is authoritative
 * ```
 *
 * **This is the last thing that reads `mesh.json`.** The file is a genesis format: it says what a
 * repository builds, this writes that onto rows, and every later question — what is the entry, what
 * kernel range, which contracts does it call — is answered by the catalog. A repository that edits
 * its descriptor afterwards has changed nothing until somebody imports it again, which is the
 * coupling being removed rather than an oversight.
 *
 * It publishes nothing and builds nothing. Importing says *these parts exist and here is how they
 * are built*; `builder.release_part` is what turns that into a version and an artifact.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuilderService } from '../builder.service.js';
import { importRepoContract } from '../contracts/artifact.contract.js';
import { resolveGitSource } from '../methods/source.js';
import { DESCRIPTOR_FILE, parseDescriptor, requirementsOf } from '../schema/descriptor.js';

type Input = z.infer<typeof importRepoContract['inputSchema']>;
type Output = z.infer<typeof importRepoContract['outputSchema']>;

export async function builder_import_repo(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = ctx.meta?.user?.tenant_id ?? ctx.meta?.tenant_id;
    if (caller === undefined || caller === '') {
        throw new ClientError(
            'Importing a repository names one this node will clone with whatever credential it ' +
            'holds, so it requires an authenticated caller. This call carries none.',
            'caller_unknown', 401,
        );
    }

    // A branch becomes a commit before anything else happens, so an import is a fact about one
    // commit rather than about whatever `main` happened to be during the clone.
    const source = await resolveGitSource({
        repository: input.repository,
        ref: input.ref,
        ...(input.subdirectory === undefined ? {} : { subdirectory: input.subdirectory }),
    });

    const workspace = await mkdtemp(join(tmpdir(), 'mesh-import-'));

    try {
        ctx.logger.info(`[builder] importing ${input.repository} @ ${source.ref.slice(0, 12)}`);
        await this.fetch(source, workspace);

        const root = input.subdirectory === undefined
            ? workspace
            : join(workspace, input.subdirectory);

        const text = await readFile(join(root, DESCRIPTOR_FILE), 'utf8').catch(() => undefined);
        if (text === undefined) {
            throw new ClientError(
                `${input.repository} has no ${DESCRIPTOR_FILE} at ${input.ref}` +
                `${input.subdirectory === undefined ? '' : ` under ${input.subdirectory}`}. ` +
                `An import reads one to learn what the repository builds; a part can also be ` +
                `declared directly with catalog.declare.`,
                'descriptor_missing', 404,
            );
        }

        const descriptor = parseDescriptor(text);
        const parts: Output['parts'] = [];

        for (const part of descriptor.parts) {
            /**
             * **The version in the descriptor is ignored, and that is the point.**
             *
             * A repository holding its own version number is the thing being removed: it has to be
             * edited to ship, and the number it holds is a claim the catalog cannot check. Labels
             * are minted by `release_part` from what is actually published.
             */
            const declaration = {
                entry: part.entry,
                branch: input.ref,
                ...(input.subdirectory === undefined ? {} : { subdirectory: input.subdirectory }),
                // A kernel has no kernel. Everything else carries the range it is written against,
                // which is the only thing standing between a stale part and a browser.
                ...(part.kind === 'kernel' || descriptor.kernel === undefined
                    ? {}
                    : { kernel: descriptor.kernel }),
                requires: [...requirementsOf(part)],
                requiredParts: part.requiredParts,
            };

            if (input.dryRun === true) {
                parts.push({ name: part.id, kind: part.kind, entry: part.entry, existed: false });
                continue;
            }

            const declared = await ctx.call('catalog.declare', {
                name: part.id,
                kind: part.kind,
                repository: input.repository,
                declaration,
                ...(part.description === undefined ? {} : { description: part.description }),
                ...(part.homepage === undefined ? {} : { homepage: part.homepage }),
                ...(part.license === undefined ? {} : { license: part.license }),
                ...(part.keywords === undefined ? {} : { keywords: part.keywords }),
                ...(part.icon === undefined ? {} : { icon: part.icon }),
            });

            parts.push({
                name: part.id, kind: part.kind, entry: part.entry, existed: declared.existed,
            });
        }

        return { repository: input.repository, commit: source.ref, parts };
    } finally {
        // Ours, and destroyed whatever happened. A caller never learns where it was.
        await rm(workspace, { recursive: true, force: true });
    }
}
