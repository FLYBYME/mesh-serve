/**
 * `mesh-serve publish` — a repository's `mesh.json` into catalog rows.
 *
 * This is the one moment `mesh.json` is read as the genesis object. After it, the collection is
 * authoritative: the builder looks up a part and a version rather than a repository, and a
 * repository that edits its descriptor cannot change what an already-published version builds.
 *
 * ```
 * mesh.json + the current commit  →  catalog.publish, once per part  →  builder.build_start, once per part
 * ```
 *
 * **Each part is published separately**, which is why a repository with a chrome extension and an
 * application produces two catalog entries and two artifacts. They are versioned, resolved, cached
 * and replaced independently from then on — which is the whole reason installing an extension is
 * not a site rebuild.
 *
 * It does not build. Publishing says *this version exists and is buildable*; a version is `declared`
 * until something builds it, and that separation is what lets a build be retried, moved to another
 * node, or run again after an artifact has gone.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { parseDescriptor, requirementsOf, type DescribedPart } from '../builder/schema/descriptor.js';

const run = promisify(execFile);

export interface PublishArgs {
    readonly descriptor: string;
    /** The organization that owns these parts. Checked by the builder before it clones anything. */
    readonly publisher: string | undefined;
    /** Where the source is. Read from the git remote when not given. */
    readonly repository: string | undefined;
    /** Print what would be published and write nothing. */
    readonly dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): PublishArgs {
    const value = (flag: string): string | undefined => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
    };

    return {
        descriptor: value('--descriptor') ?? 'mesh.json',
        publisher: value('--publisher'),
        repository: value('--repository'),
        dryRun: argv.includes('--dry-run'),
    };
}

/**
 * What a part publishes as, from its descriptor plus the commit.
 *
 * `requires` is flattened here rather than in the catalog, because flattening is a property of the
 * descriptor's shape — `mesh[]` groups contracts by package so a build can verify them, and what a
 * site needs to check against its grants is the flat list.
 */
export function versionFrom(part: DescribedPart, commit: string, kernel: string | undefined): {
    version: string; commit: string; entry: string; kernel?: string;
    requires: string[]; requiredParts: DescribedPart['requiredParts'];
} {
    return {
        version: part.version,
        commit,
        entry: part.entry,
        // A kernel has no kernel. Everything else carries the range it was written against, which is
        // the only thing standing between a stale part and a browser.
        ...(part.kind === 'kernel' || kernel === undefined ? {} : { kernel }),
        requires: [...requirementsOf(part)],
        requiredParts: part.requiredParts,
    };
}

/**
 * The commit this working tree is on, and whether it is clean.
 *
 * A dirty tree is refused. Publishing `1.0.0` from a commit that does not contain the code you are
 * looking at produces a version that builds something nobody has seen — and because a version is
 * immutable, the only fix afterwards is to burn the version number.
 */
export async function currentCommit(root: string): Promise<string> {
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: root });
    if (status.trim() !== '') {
        throw new Error(
            'This working tree has uncommitted changes. A published version is immutable and is ' +
            'built from a commit, so publishing now would pin a version to code that is not what ' +
            'you are looking at. Commit first.',
        );
    }

    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim();
}

/** The push remote, so a repository need not repeat where it lives. */
async function originUrl(root: string): Promise<string | undefined> {
    try {
        const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: root });
        const url = stdout.trim();
        // `git@github.com:owner/repo.git` → `https://github.com/owner/repo.git`, because the builder
        // fetches over HTTPS with a token and has no ssh key.
        return url.startsWith('git@')
            ? `https://${url.slice(4).replace(':', '/')}`
            : url;
    } catch {
        return undefined;
    }
}

export async function run_(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    const root = process.cwd();

    const descriptor = parseDescriptor(readFileSync(resolve(args.descriptor), 'utf8'));
    const commit = await currentCommit(root);
    const repository = args.repository ?? await originUrl(root);

    if (repository === undefined) {
        process.stderr.write(
            'No repository. This tree has no `origin` remote, so pass --repository.\n',
        );
        return 1;
    }

    if (args.publisher === undefined) {
        // Not defaulted. A publisher is who may build this part with whatever credential a builder
        // holds, so guessing one would be guessing at an authorization boundary.
        process.stderr.write('No publisher. Pass --publisher <organization>.\n');
        return 1;
    }

    for (const part of descriptor.parts) {
        const version = versionFrom(part, commit, descriptor.kernel);
        process.stdout.write(
            `${part.kind} ${part.id}@${part.version}\n` +
            `  ${repository} @ ${commit.slice(0, 12)}\n` +
            `  entry ${part.entry}\n` +
            (version.requires.length === 0 ? '' : `  calls ${version.requires.join(', ')}\n`),
        );
    }

    if (args.dryRun) return 0;

    // Publishing needs a broker: `catalog.publish` is a contract, not a local function, and it is
    // the collection that enforces version immutability. A CLI that wrote rows directly would be a
    // second path into the catalog and would not enforce it.
    process.stderr.write(
        '\nThis prints what would be published. Writing it needs a broker connection, which this ' +
        'command does not open yet — call catalog.publish with the values above.\n',
    );
    return 0;
}
