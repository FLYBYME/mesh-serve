/**
 * What a part was built against, read from the lockfile.
 *
 * ## Why the lockfile and not `node_modules`
 *
 * The predecessor read `node_modules/<name>/package.json`, on the argument that `^1.2.0` is a wish
 * and the installed version is the fact. That argument still holds — but **a build does not install
 * any more**, so there is no `node_modules` in the workspace to read.
 *
 * The lockfile is better anyway, and not as a fallback:
 *
 * - It is **committed**, so it is in the fetched tree with nothing to run.
 * - It records what the author had installed **when they typechecked**, which is the fact worth
 *   having. Typechecking is the author's job now; this is the evidence of what it was done against.
 * - It is **the only thing that knows a git commit.** An installed package's own `package.json`
 *   carries the version its author wrote and no trace of which commit was fetched, and
 *   `@flybyme/mesh-web` says `0.1.0` on every build forever because nothing bumps the version of a
 *   package consumed from a branch. `resolved` carries `…mesh-web.git#<sha>`.
 * - It covers **workspaces** for free. The first version of this read only the root `package.json`
 *   and returned nothing at all against the first real repository, because that repository was a
 *   workspace with its dependency declared one level down — not an exotic layout, just what a
 *   repository with two halves naturally is. A lockfile has one entry per package either way.
 *
 * Direct dependencies only. The whole tree would be noise, and the question this answers is *what
 * did the author write this against*, not *what is in the graph*.
 */

import type { ResolvedDependency } from '../schema/artifact.js';

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Every direct dependency the lockfile knows about, sorted by name.
 *
 * An unreadable or absent lockfile yields nothing, and that is the right answer: **a missing fact is
 * recorded as missing.** Inventing a version from a range would put a false fact in an artifact,
 * which is worse than an absent one, because something downstream compares against it.
 */
export function dependenciesFrom(lockText: string | undefined): readonly ResolvedDependency[] {
    if (lockText === undefined) return [];

    let lock: Record<string, unknown>;
    try {
        lock = asRecord(JSON.parse(lockText));
    } catch {
        return [];
    }

    const packages = asRecord(lock['packages']);

    // Which names anything in this repository actually asked for. The root entry is `""`; a
    // workspace is its directory, e.g. `ui`. An entry under `node_modules/` is something installed,
    // which is what we are resolving *to* rather than a declaration.
    const direct = new Set<string>();
    for (const [path, entry] of Object.entries(packages)) {
        if (path.includes('node_modules/')) continue;
        const manifest = asRecord(entry);
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            for (const name of Object.keys(asRecord(manifest[field]))) direct.add(name);
        }
    }

    const resolved: ResolvedDependency[] = [];

    for (const [path, entry] of Object.entries(packages)) {
        const at = path.lastIndexOf('node_modules/');
        if (at === -1) continue;

        const name = path.slice(at + 'node_modules/'.length);
        if (!direct.has(name)) continue;

        const installed = asRecord(entry);
        const version = installed['version'];
        if (typeof version !== 'string' || version.trim() === '') continue;

        // A registry tarball URL has no fragment, so this selects git dependencies without having to
        // recognise a host.
        const from = installed['resolved'];
        const hash = typeof from === 'string' ? from.lastIndexOf('#') : -1;
        const commit = hash === -1 ? undefined : (from as string).slice(hash + 1);

        resolved.push(
            commit !== undefined && COMMIT.test(commit)
                ? { package: name, version, commit }
                : { package: name, version },
        );
    }

    // Sorted, and de-duplicated by name: a package hoisted at the root and nested under a workspace
    // is one dependency seen twice. An artifact's declaration must not depend on the order a JSON
    // object happened to be written in, or identical source would publish under two digests.
    const byName = new Map(resolved.map((dependency) => [dependency.package, dependency]));
    return [...byName.values()].sort((a, b) => a.package.localeCompare(b.package));
}
