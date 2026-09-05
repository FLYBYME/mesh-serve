/**
 * `builder.build_start` — fetch a commit, build every part the repository declares.
 *
 * ```
 * SourceRef  →  a workspace this builder owns  →  bytes  →  one content-addressed artifact per part
 * ```
 *
 * Nothing outside ever gets a path. The workspace is created, used and destroyed here, and the only
 * thing that leaves is content plus a digest — which is what makes *"the code need not be local to
 * the server"* true rather than aspirational.
 *
 * What happens to one part is `publishPart`, in `methods/`. This is the repository half: resolve the
 * ref, fetch it, read what it declares, and read the lockfile once for all of them.
 */

import { z, type IServiceContext } from '@flybyme/mesh';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuilderService } from '../builder.service.js';
import { buildStartContract } from '../contracts/artifact.contract.js';
import { dependenciesFrom } from '../methods/lockfile.js';
import { publishPart } from '../methods/publish.js';
import { describeSource, resolveSource } from '../methods/source.js';
import { DESCRIPTOR_FILE, parseDescriptor } from '../schema/descriptor.js';

type Input = z.infer<typeof buildStartContract['inputSchema']>;
type Output = z.infer<typeof buildStartContract['outputSchema']>;

export async function builder_build_start(
    this: BuilderService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    // Before anything else, and before a build record could exist holding it: a branch hashes to
    // itself forever while the code underneath it moves, so a cache keyed on one would serve a stale
    // artifact indefinitely — a deploy that silently does nothing, found days later.
    const source = await resolveSource(input.source);

    // Ours, and destroyed in the `finally`. A caller never learns where it was.
    const workspace = await mkdtemp(join(tmpdir(), 'mesh-build-'));

    try {
        ctx.logger.info(`[builder] fetching ${describeSource(source)}`);
        await this.fetch(source, workspace);

        const root = source.kind === 'git' && source.subdirectory !== undefined
            ? join(workspace, source.subdirectory)
            : workspace;

        const descriptor = parseDescriptor(await readFile(join(root, DESCRIPTOR_FILE), 'utf8'));

        // Read once for the whole repository: one lockfile at the root, even with workspaces. It is
        // committed, so it is here with nothing installed and nothing to run.
        const builtAgainst = dependenciesFrom(
            await readFile(join(root, 'package-lock.json'), 'utf8').catch(() => undefined),
        );

        const builds: Output['builds'] = [];
        for (const part of descriptor.parts) {
            builds.push(await publishPart(this, {
                part, root, source, kernel: descriptor.kernel, builtAgainst,
            }, ctx));
        }

        return { builds };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}
