/**
 * Content addressing, and the input hash.
 *
 * Two of the builder's requirements are really one idea:
 *
 * - **the artifact is content, not a path** — so it can move between nodes
 * - **builds are cacheable by input hash** — so the same commit does not rebuild
 *
 * Both need a hash that means the same thing everywhere, which is what this file is for. Everything
 * here is pure and synchronous: a hash that depended on when or where it was computed would defeat
 * the point of having one.
 */

import { createHash } from 'node:crypto';

import type { ArtifactFile } from '../schema/artifact.js';
import type { BuildInputs, SourceRef } from '../schema/build.js';

/** `sha256:` and 32 hex characters. Long enough to be safe, short enough to read in a log. */
export const digestOf = (content: Buffer | string): string =>
    `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;

/**
 * JSON with every object's keys sorted, so equal values serialise equally.
 *
 * `JSON.stringify` alone orders keys by insertion, so two inputs that mean the same thing would hash
 * differently depending on how they were built — and a cache that missed on that would look like a
 * builder that never caches.
 */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The digest of a whole file set.
 *
 * Over the *names and digests*, sorted — not over the concatenated bytes. Two artifacts with the
 * same files in a different order are the same artifact, and a node that already holds one can skip
 * the fetch. Hashing bytes in directory order would make identity depend on a filesystem.
 */
export function artifactDigest(files: readonly ArtifactFile[]): string {
    const manifest = [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => `${file.path} ${file.digest}`)
        .join('\n');

    return digestOf(manifest);
}

/**
 * The hash of everything that determines the output.
 *
 * Refuses a source that has not been resolved to a commit, rather than warning: a cache key computed
 * from a branch name is a bug that surfaces as *"the deploy did nothing"*, days later, with nothing
 * in any log.
 */
export function inputHash(inputs: BuildInputs): string {
    assertResolved(inputs.source);
    return digestOf(canonical(inputs));
}

const COMMIT = /^[0-9a-f]{40}$/;

export function assertResolved(source: SourceRef): void {
    if (source.kind === 'archive') {
        if (source.digest.trim() === '') {
            throw new Error('An archive source needs a digest, or nothing can tell whether it changed.');
        }
        return;
    }

    if (!COMMIT.test(source.ref)) {
        throw new Error(
            `Source ref "${source.ref}" is not a commit. A branch hashes to itself while the code ` +
            `underneath it changes, so a build cached on one would serve a stale artifact forever. ` +
            `Resolve it first.`,
        );
    }
}

/**
 * The URL prefix an artifact is served under — see `src/cdn/methods/resolve.ts`.
 *
 * A digest contains a colon, which is legal in a URL path segment but reads badly and is escaped
 * inconsistently by tooling. The hex half alone is the identity; the algorithm prefix is carried in
 * the record, where something might one day have to migrate it.
 */
export const artifactSlug = (digest: string): string => {
    const colon = digest.indexOf(':');
    return colon === -1 ? digest : digest.slice(colon + 1);
};

/**
 * Content type from a file name.
 *
 * Kept here rather than pulled in: the set that matters for a built part is small, and a wrong
 * answer is a page that does not run. `.js` in particular — a browser refuses a module served as
 * `text/plain`, and that failure is invisible in the network tab.
 */
const TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm',
};

export function contentTypeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}
