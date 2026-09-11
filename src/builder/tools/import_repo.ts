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
import { declareContract } from '../../catalog/contracts/part.contract.js';
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
                // Absent on an agent part, which has no source. `catalog.declare` refuses an agent
                // that carries one and a buildable kind that does not.
                ...(part.entry === undefined ? {} : { entry: part.entry }),
                ...(part.roles === undefined ? {} : { roles: part.roles }),
                // What other parts import this one as. Read once at import, like everything else on
                // a declaration — the collection is authoritative from then on.
                ...(part.import === undefined ? {} : { import: part.import }),
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

            const declared = await declarePart(ctx, part.id, {
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
                // A kernel reports what it declares; nothing else does. See the contract's own note:
                // the kernel is the one part every other part names a range against, so its label
                // has to mean what those parts think it means.
                ...(part.kind === 'kernel' && part.version !== undefined ? { version: part.version } : {}),
            });
        }

        return { repository: input.repository, commit: source.ref, parts };
    } finally {
        // Ours, and destroyed whatever happened. A caller never learns where it was.
        await rm(workspace, { recursive: true, force: true });
    }
}

/**
 * **`catalog.declare`, with the one refusal that needs translating.**
 *
 * A part name is **one global namespace**, so the second organization to import a repository whose
 * parts somebody else already published is refused — correctly. `catalog.declare` answers *No such
 * part*, 404, and its comment says why that wording is deliberate: *"not found, not forbidden: which
 * organization publishes a part is not something an unrelated caller gets to confirm by probing."*
 *
 * Correct, and unusable at the point it arrives. A person seeding a site names three repositories,
 * gets `No such part`, and goes looking at the catalog — which is the one place the answer is not.
 * The part exists; the caller may not claim it. Roadmap **F24**, and it cost a seed on the day it was
 * logged and another on the day it was fixed.
 *
 * So the category and the way out are stated here, where the part's name and the repository are both
 * known, and **nothing is added that the caller did not already supply**: they named this repository,
 * so hearing that its parts are published by somebody else confirms nothing they could not learn by
 * reading their own command. Which organization is still not said.
 *
 * The check is structural rather than `instanceof ClientError`, for F26's reason: a `--service`
 * brings its own copy of `@flybyme/mesh`, so a thrown error that crossed a module boundary is not an
 * instance of the class this file imported.
 */
async function declarePart(
    ctx: IServiceContext,
    name: string,
    params: z.infer<typeof declareContract['inputSchema']>,
): Promise<{ partId: string; name: string; existed: boolean }> {
    try {
        return await ctx.call('catalog.declare', params) as { partId: string; name: string; existed: boolean };
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 'part_not_found') throw error;

        throw new ClientError(
            `"${name}" is already published by another organization, and a part name is one global `
            + `namespace — so importing ${params.repository} cannot claim it. `
            + `If you meant to use their copy, do not import this repository: name "${name}" among `
            + `the parts to compose and the catalog resolves it across publishers. If you meant a `
            + `part of your own, give it a different name.`,
            'part_published_elsewhere', 409,
        );
    }
}
