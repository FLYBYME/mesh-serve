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
    /**
     * A node already in the cluster, to join through.
     *
     * Publishing writes to a collection, and a collection lives on the mesh — so this command joins
     * as a **temporary node** rather than opening a database. That is the same thing `mesh stats`
     * does, and it matters for a reason beyond convenience: writing rows directly would be a second
     * path into the catalog, one that skips the immutability check `catalog.publish` exists to
     * enforce.
     */
    readonly bootstrap: readonly string[];
    /** How long to wait for the catalog to appear before giving up. */
    readonly timeoutMs: number;
}

export function parseArgs(argv: readonly string[]): PublishArgs {
    const value = (flag: string): string | undefined => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
    };

    const bootstrap = value('--bootstrap') ?? process.env['MESH_BOOTSTRAP'];

    return {
        descriptor: value('--descriptor') ?? 'mesh.json',
        publisher: value('--publisher'),
        repository: value('--repository'),
        dryRun: argv.includes('--dry-run'),
        bootstrap: bootstrap === undefined
            ? []
            : bootstrap.split(',').map((node) => node.trim()).filter((node) => node !== ''),
        timeoutMs: Number(value('--timeout') ?? '10000'),
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

    if (args.bootstrap.length === 0) {
        process.stderr.write(
            '\nNo cluster to publish to. Pass --bootstrap ws://host:port (or set MESH_BOOTSTRAP), '
            + 'or --dry-run to see what would be published.\n',
        );
        return 1;
    }

    const cluster = await join(args);

    try {
        for (const part of descriptor.parts) {
            const version = versionFrom(part, commit, descriptor.kernel);

            const published = await cluster.call<{ existed: boolean; versionId: string }>(
                'catalog.publish',
                {
                    name: part.id,
                    kind: part.kind,
                    repository,
                    publisher: args.publisher,
                    version: version.version,
                    commit: version.commit,
                    entry: version.entry,
                    ...(version.kernel === undefined ? {} : { kernel: version.kernel }),
                    requires: version.requires,
                    capabilities: {
                        needs: [],
                        provides: [],
                    },
                },
            );

            process.stdout.write(published.existed
                ? `  ${part.id}@${part.version} already published\n`
                : `  ${part.id}@${part.version} published\n`);
        }
    } catch (error) {
        // Named rather than swallowed: the most likely failure is version immutability refusing a
        // republish from a different commit, and that message says which two commits disagree.
        process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    } finally {
        await cluster.stop();
    }

    return 0;
}

/**
 * Join the cluster as a temporary node.
 *
 * The same shape `mesh stats` uses: a node with no database and no modules of its own, which
 * discovers the cluster, makes its calls, and leaves. It is not a client of the catalog so much as a
 * peer that happens to be short-lived — which is what lets `catalog.publish` be an ordinary contract
 * rather than something with a second, CLI-shaped entrance.
 */
async function join(args: PublishArgs): Promise<{
    call<T>(tool: string, params: unknown): Promise<T>;
    stop(): Promise<void>;
}> {
    const { BrokerModule, JSONSerializer, MeshApp, NetworkModule, RegistryModule } =
        await import('@flybyme/mesh');
    // The only piece that is node-specific: a WebSocket that dials out. Everything else is the same
    // framework a browser would use, which is why it lives behind a separate entry point.
    const { WSTransport } = await import('@flybyme/mesh/node');

    const app = new MeshApp({ nodeID: `publish-${Math.random().toString(36).slice(2, 7)}` });

    app.use(new RegistryModule());
    app.use(new NetworkModule({
        // Port 0: this node is dialling out and nothing dials it.
        port: 0,
        transports: [new WSTransport(new JSONSerializer(), 0)],
        bootstrapNodes: [...args.bootstrap],
    }));
    app.use(new BrokerModule());
    await app.start();

    // Discovery is not instant, and a call made before the catalog is known fails as "no such tool"
    // — which reads as a broken cluster rather than as one this node has not met yet.
    const deadline = Date.now() + args.timeoutMs;
    const registry = app as unknown as { registry: { waitForTool?(tool: string, ms: number): Promise<unknown> } };

    if (typeof registry.registry.waitForTool === 'function') {
        await registry.registry.waitForTool('catalog.publish', args.timeoutMs);
    } else {
        while (Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    }

    return {
        call: <T,>(tool: string, params: unknown): Promise<T> =>
            (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<T> })
                .call(tool, params, { meta: { user: { id: 'cli', tenant_id: args.publisher ?? '' } } }),
        stop: () => app.stop(),
    };
}
