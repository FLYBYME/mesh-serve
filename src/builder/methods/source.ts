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
/**
 * A credential for one host, if this node has one.
 *
 * A function rather than a map, so a token can come from a collection later without this signature
 * changing. Returning `undefined` is the ordinary case: a public repository needs nothing.
 */
export type CredentialFor = (host: string) => string | undefined;

/**
 * Tokens from the environment, keyed by host.
 *
 * `GIT_TOKEN_GITHUB_COM=ghp_…` — the host uppercased with dots as underscores, so one node can hold
 * credentials for more than one forge without inventing a config format. `GIT_TOKEN` alone is the
 * fallback for a node that only ever talks to one.
 *
 * **This is the single-operator answer and it does not survive multi-tenancy** — see
 * `spec/building.md`. One token per node means the builder can read every repository that token can
 * read, and `build_start` currently takes an arbitrary repository URL from its caller.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialFor {
    return (host) => {
        const key = `GIT_TOKEN_${host.toUpperCase().replace(/[.-]/g, '_')}`;
        const found = env[key] ?? env['GIT_TOKEN'];
        return found === undefined || found.trim() === '' ? undefined : found;
    };
}

const hostOf = (repository: string): string => {
    try {
        return new URL(repository).host;
    } catch {
        // `git@github.com:owner/repo.git`. Not a URL, and the host is still the useful part.
        return repository.split('@')[1]?.split(':')[0] ?? '';
    }
};

/**
 * Clone one commit into a workspace the builder owns.
 *
 * `--depth 1` of a single revision: a builder needs the tree at one commit and nothing else, and
 * fetching a project's whole history to build one page is the difference between a fast builder and
 * a slow one.
 *
 * ## Where the credential goes, and where it must not
 *
 * As `http.extraHeader` on the one fetch, **never in the remote URL**. A URL with a token in it is
 * written into `.git/config`, echoed by git's own error messages, and — the reason that matters
 * here — a failed build's log is stored on the build row and travels with the failure. A token in a
 * remote URL ends up in the database.
 *
 * It is still visible in this process's argv while the fetch runs, which is a smaller exposure than
 * the log and not nothing. A credential helper would close it; recorded rather than pretended away.
 */
export function createGitFetcher(credentialFor: CredentialFor = credentialsFromEnv()): Fetcher {
    return async (source, into) => {
        if (source.kind !== 'git') {
            throw new Error(`gitFetcher cannot fetch a ${source.kind} source.`);
        }

        const token = credentialFor(hostOf(source.repository));

        // `x-access-token` is the username GitHub expects for a token; other forges ignore it and
        // read the password half, so one form covers both.
        const auth = token === undefined
            ? []
            : ['-c', `http.extraHeader=Authorization: Basic ${
                Buffer.from(`x-access-token:${token}`).toString('base64')}`];

        await run('git', ['init', '--quiet'], { cwd: into });
        await run('git', ['remote', 'add', 'origin', source.repository], { cwd: into });

        try {
            await run('git', [...auth, 'fetch', '--quiet', '--depth', '1', 'origin', source.ref], { cwd: into });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Named, because the failure is otherwise an opaque git error about a repository that
            // "does not exist" — which is what a private repository looks like to an anonymous
            // fetch, and is the single most confusing way for this to go wrong.
            throw new Error(
                token === undefined
                    ? `Could not fetch ${source.repository}. This builder holds no credential for ` +
                      `${hostOf(source.repository)}, and a private repository is indistinguishable ` +
                      `from one that does not exist. ${redact(message, token)}`
                    : `Could not fetch ${source.repository}. ${redact(message, token)}`,
            );
        }

        await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: into });
    };
}

/** A token must never reach a build log, which is stored and travels with a failure. */
const redact = (text: string, token: string | undefined): string =>
    token === undefined ? text : text.split(token).join('«token»');

export const gitFetcher: Fetcher = createGitFetcher();

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
