/**
 * How a source reference becomes a directory this builder owns.
 *
 * The two rules from the previous generation's defects, both enforced here rather than asked for:
 * **a source is a reference, never a path**, and **a builder fetches into a workspace it chose**. A
 * caller never learns where that was, which is the whole of "the code need not be local to the
 * server".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SourceRef } from '../schema/build.js';

const run = promisify(execFile);

/**
 * How a `SourceRef` becomes a workspace.
 *
 * A type, so the *rule* can be tested without a network: a fetcher receives a reference and a
 * destination it did not choose, which is what stops a source ever being "wherever it already is".
 */
export type Fetcher = (source: SourceRef, into: string) => Promise<void>;

export const describeSource = (source: SourceRef): string =>
    source.kind === 'git' ? `${source.repository}@${source.ref}` : source.url;

/**
 * Clone one commit into a workspace the builder owns.
 *
 * `--depth 1` of a single revision: a builder needs the tree at one commit and nothing else, and
 * fetching a project's whole history to build one page is the difference between a fast builder and
 * a slow one.
 */
export const gitFetcher: Fetcher = async (source, into) => {
    if (source.kind !== 'git') {
        throw new Error(`gitFetcher cannot fetch a ${source.kind} source.`);
    }

    await run('git', ['init', '--quiet'], { cwd: into });
    await run('git', ['remote', 'add', 'origin', source.repository], { cwd: into });
    await run('git', ['fetch', '--quiet', '--depth', '1', 'origin', source.ref], { cwd: into });
    await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: into });
};

/**
 * Turn a branch or tag into the commit it points at.
 *
 * Called *before* a build record exists, so an input hash is always over a commit. Without it a
 * cache keyed on `main` would answer the same forever while the code moved underneath it — a deploy
 * that silently does nothing, discovered days later with nothing in any log.
 */
export async function resolveSource(source: {
    readonly kind: 'git' | 'archive';
    readonly repository?: string;
    readonly ref?: string;
    readonly subdirectory?: string;
    readonly url?: string;
    readonly digest?: string;
}): Promise<SourceRef> {
    if (source.kind === 'archive') {
        return { kind: 'archive', url: source.url ?? '', digest: source.digest ?? '' };
    }

    const repository = source.repository ?? '';
    const ref = source.ref ?? '';
    const at = source.subdirectory === undefined ? {} : { subdirectory: source.subdirectory };

    if (/^[0-9a-f]{40}$/.test(ref)) return { kind: 'git', repository, ref, ...at };

    const { stdout } = await run('git', ['ls-remote', repository, ref]);
    const commit = stdout.split(/\s/)[0];

    if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error(`${repository} has no ref "${ref}".`);
    }

    return { kind: 'git', repository, ref: commit, ...at };
}
