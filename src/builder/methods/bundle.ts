/**
 * esbuild, once per part.
 *
 * ## What this does not do
 *
 * **No `npm ci`.** The predecessor ran an install inside every build, measured at 95 to 125 seconds
 * per site, most of it cloning the framework. It is possible to drop because **esbuild does not
 * typecheck** — it strips types and emits — so a part whose only dependency is external needs
 * nothing installed at all. Typechecking is the author's job, in their own repository.
 *
 * **No build command.** The predecessor ran the repository's own `sh -c` line, which is what made
 * `npm ci` possible and made the threat model *arbitrary code from a repository*. A repository names
 * an entry now. No plugins are passed and no lifecycle script runs, so what a repository can ask for
 * is a bundle of its own source and nothing else.
 *
 * **No timeout**, and that is a consequence rather than an omission: a timeout existed because a
 * repository's build command could hang forever, and bundling a fixed set of files cannot.
 *
 * **No writing.** `write: false`, so output never touches a disk the artifact could accidentally
 * describe. What comes back is bytes and a notional name, which is exactly what an `ArtifactFile` is.
 */

import { build as esbuild } from 'esbuild';
import { join, relative } from 'node:path';

import type { ArtifactFile } from '../schema/artifact.js';
import type { DescribedPart } from '../schema/descriptor.js';
import { contentTypeOf, digestOf } from './content.js';

/**
 * The one specifier a part may import and not carry.
 *
 * A part is bundled with this `external`; the page's import map resolves it to the one mounted
 * kernel artifact. **This single line separates "one kernel, many parts" from "many kernels
 * pretending".** mesh-ui aliased it to a browser build instead, which esbuild then inlined into
 * every extension: 1.1 MB across 192 files against an app's own 72 KB across 8, so 94% of every
 * artifact was a private copy of the framework — and, far worse, two copies under two URLs are two
 * module graphs and two of every singleton the capability model depends on.
 */
export const FRAMEWORK = '@flybyme/mesh-web';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface Bundled {
    readonly files: readonly ArtifactFile[];
    /** The bytes, by digest. The caller decides where they go; this decides nothing. */
    readonly blobs: ReadonlyMap<string, Buffer>;
}

/**
 * Bundle one part from a checked-out tree.
 *
 * @param root the workspace the fetcher wrote, which the caller owns and destroys
 */
export async function bundlePart(
    root: string,
    /**
     * Only what a bundle actually depends on: where the source starts, what to call the output, and
     * whether this is the kernel. Deliberately *not* a whole descriptor — the catalog is what a
     * build reads now, and a parameter that accepted a descriptor would invite reading one.
     */
    part: Pick<DescribedPart, 'kind' | 'id' | 'entry'>,
    maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Bundled> {
    const outdir = join(root, '.mesh-out');

    const result = await esbuild({
        entryPoints: [join(root, part.entry)],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        // The kernel *is* the framework, so it has nothing to leave out. Everything else leaves out
        // exactly one specifier and takes it from the import map instead.
        external: part.kind === 'kernel' ? [] : [FRAMEWORK],
        // Every part's entry is `index.js` inside its own artifact. The name means nothing outside
        // it — the artifact is addressed by hash, and the page imports it by that.
        entryNames: 'index',
        assetNames: 'assets/[name]-[hash]',
        outdir,
        write: false,
        absWorkingDir: root,
        // A source map would embed absolute paths from a workspace that no longer exists by the time
        // anyone reads one — a location, in an artifact whose whole design says it has none. Left
        // off until there is an answer that does not leak one.
        sourcemap: false,
        minify: true,
        logLevel: 'silent',
    });

    const files: ArtifactFile[] = [];
    const blobs = new Map<string, Buffer>();
    let total = 0;

    for (const output of result.outputFiles ?? []) {
        const content = Buffer.from(output.contents);
        total += content.length;
        if (total > maxBytes) {
            throw new Error(`${part.id} produced more than ${String(maxBytes)} bytes.`);
        }

        // Always forward slashes: this is a name inside an artifact, not a path on the machine that
        // happened to build it.
        const path = relative(outdir, output.path).split(/[\\/]/).join('/');
        const digest = digestOf(content);

        blobs.set(digest, content);
        files.push({ path, digest, size: content.length, contentType: contentTypeOf(path) });
    }

    if (files.length === 0) {
        // Cannot happen with a valid entry, and it is checked because an empty artifact would serve
        // a blank page rather than fail — a deploy that appears to work is worse than one that
        // plainly does not.
        throw new Error(`${part.id} produced no files.`);
    }

    return { files, blobs };
}
