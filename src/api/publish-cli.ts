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
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { IMeshApp, IServiceToolRegistry } from '@flybyme/mesh';

import { parseDescriptor, requirementsOf, type DescribedPart } from '../builder/schema/descriptor.js';

const run = promisify(execFile);

export interface PublishArgs {
    readonly descriptor: string;
    /** The organization that owns these parts. Checked against verified token if provided. */
    readonly publisher: string | undefined;
    /** Where the source is. Read from the git remote when not given. */
    readonly repository: string | undefined;
    /** Print what would be published and write nothing. */
    readonly dryRun: boolean;
    /** API token for machine authentication. Read from --token, MESH_TOKEN, or MESH_API_TOKEN. */
    readonly token: string | undefined;
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

    let token = value('--token') ?? process.env['MESH_TOKEN'] ?? process.env['MESH_API_TOKEN'];
    if (token !== undefined && token.trim() === '') {
        token = undefined;
    }

    return {
        descriptor: value('--descriptor') ?? 'mesh.json',
        publisher: value('--publisher'),
        repository: value('--repository'),
        dryRun: argv.includes('--dry-run'),
        token,
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

    if (!args.dryRun && args.token === undefined) {
        process.stderr.write(
            'No credential. Publishing requires an API token. ' +
            'Pass --token <token> or set MESH_TOKEN.\n',
        );
        return 1;
    }

    const descriptorPath = resolve(args.descriptor);
    const root = dirname(descriptorPath);
    const descriptor = parseDescriptor(readFileSync(descriptorPath, 'utf8'));
    const commit = await currentCommit(root);
    const repository = args.repository ?? await originUrl(root);

    if (repository === undefined) {
        process.stderr.write(
            'No repository. This tree has no `origin` remote, so pass --repository.\n',
        );
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

    const token = args.token;
    if (token === undefined) {
        process.stderr.write(
            'No credential. Publishing requires an API token. ' +
            'Pass --token <token> or set MESH_TOKEN.\n',
        );
        return 1;
    }

    if (args.bootstrap.length === 0) {
        process.stderr.write(
            '\nNo cluster to publish to. Pass --bootstrap ws://host:port (or set MESH_BOOTSTRAP), '
            + 'or --dry-run to see what would be published.\n',
        );
        return 1;
    }

    const cluster = await join(args);

    const skipped: string[] = [];
    let failed: Error | undefined;

    try {
        await cluster.waitFor('identity.api_token_validate', args.timeoutMs);
        await cluster.waitFor('catalog.publish', args.timeoutMs);

        const validation = await cluster.call('identity.api_token_validate', { token });
        if (!validation.valid) {
            process.stderr.write('\nAuthentication failed: API token is invalid, expired, or revoked.\n');
            return 1;
        }

        let publisher: string;

        if (validation.organizationId !== undefined) {
            if (args.publisher !== undefined) {
                const matchesId = args.publisher === validation.organizationId;
                const matchesSlug = validation.organizationSlug !== undefined && args.publisher === validation.organizationSlug;
                if (!matchesId && !matchesSlug) {
                    process.stderr.write(
                        `\nPublisher "${args.publisher}" does not match token organization ` +
                        `("${validation.organizationSlug ?? validation.organizationId}").\n`,
                    );
                    return 1;
                }
            }
            publisher = validation.organizationId;
        } else {
            if (validation.userId === undefined) {
                process.stderr.write('\nAuthentication failed: API token has no associated user.\n');
                return 1;
            }

            await cluster.waitFor('identity.whoami', args.timeoutMs);
            const me = await cluster.call(
                'identity.whoami',
                {},
                { meta: { user: { id: validation.userId, tenant_id: '' } } },
            );
            const memberships = me?.organizations ?? [];

            if (memberships.length === 0) {
                process.stderr.write('\nAuthentication failed: caller belongs to no organization.\n');
                return 1;
            }

            if (args.publisher !== undefined) {
                const matched = memberships.find(
                    (m) => m.organizationId === args.publisher || m.name === args.publisher,
                );
                if (matched === undefined) {
                    process.stderr.write(
                        `\nPublisher "${args.publisher}" does not match caller organization memberships.\n`,
                    );
                    return 1;
                }
                publisher = matched.organizationId;
            } else {
                if (memberships.length === 1) {
                    const only = memberships[0];
                    if (only === undefined) {
                        process.stderr.write('\nAuthentication failed: caller belongs to no organization.\n');
                        return 1;
                    }
                    publisher = only.organizationId;
                } else {
                    process.stderr.write(
                        `\nCaller belongs to ${String(memberships.length)} organizations. ` +
                        `Pass --publisher <organization> to specify which organization to publish as.\n`,
                    );
                    return 1;
                }
            }
        }

        const callMeta = {
            user: {
                id: validation.userId ?? 'cli',
                tenant_id: publisher,
                roles: validation.roles ?? ['authenticated'],
            },
            tenant_id: publisher,
        };

        for (const part of descriptor.parts) {
            const version = versionFrom(part, commit, descriptor.kernel);

            let published: { existed: boolean; versionId: string };
            try {
                published = await cluster.call(
                    'catalog.publish',
                    {
                        name: part.id,
                        kind: part.kind,
                        repository,
                        publisher,

                        // Presentation, straight through from the descriptor. This is the link that was
                        // missing: `part.description` has existed in the catalog since the beginning and
                        // nothing filled it, so a live catalog of thirteen parts had thirteen empty
                        // descriptions and a marketplace would have been a grid of bare ids.
                        ...(part.description === undefined ? {} : { description: part.description }),
                        ...(part.homepage === undefined ? {} : { homepage: part.homepage }),
                        ...(part.license === undefined ? {} : { license: part.license }),
                        ...(part.keywords === undefined ? {} : { keywords: part.keywords }),
                        ...(part.icon === undefined ? {} : { icon: part.icon }),
                        ...(part.changelog === undefined ? {} : { changelog: part.changelog }),

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
                    { meta: callMeta },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                // The one failure that is ordinary in a multi-part repository: this part did not
                // change, its version was not bumped, and the commit moved because a *sibling*
                // changed. Report it and carry on to the parts that did change.
                if (/immutable|already published from commit/i.test(message)) {
                    skipped.push(`${part.id}@${part.version}`);
                    process.stdout.write(
                        `  ${part.id}@${part.version} unchanged — already published from an ` +
                        `earlier commit, not republished\n`,
                    );
                    continue;
                }

                // Anything else is a real failure and stops the run: a publisher mismatch or a
                // changed `kind` means the descriptor disagrees with the catalog about what this
                // part is, and publishing the rest on top of that would be building on a mistake.
                failed = error instanceof Error ? error : new Error(message);
                break;
            }

            process.stdout.write(published.existed
                ? `  ${part.id}@${part.version} already published\n`
                : `  ${part.id}@${part.version} published\n`);
        }
    } finally {
        await cluster.stop();
    }

    if (failed !== undefined) {
        process.stderr.write(`\n${failed.message}\n`);
        return 1;
    }

    if (skipped.length > 0) {
        process.stderr.write(
            `\n${String(skipped.length)} part(s) were not published because their version already ` +
            `exists at an earlier commit: ${skipped.join(', ')}.\n` +
            `If any of them changed, bump its version in mesh.json — a published version is ` +
            `immutable, so the catalog still builds them from the commit they were published at.\n`,
        );
        return 2;
    }

    return 0;
}

interface ClusterNode {
    waitFor(tool: string, ms: number): Promise<void>;
    call<K extends keyof IServiceToolRegistry>(
        tool: K,
        params: IServiceToolRegistry[K]['params'],
        options?: Parameters<IMeshApp['call']>[2],
    ): Promise<IServiceToolRegistry[K]['returns']>;
    stop(): Promise<void>;
}

/**
 * Join the cluster as a temporary node.
 *
 * The same shape `mesh stats` uses: a node with no database and no modules of its own, which
 * discovers the cluster, makes its calls, and leaves. It is not a client of the catalog so much as a
 * peer that happens to be short-lived — which is what lets `catalog.publish` be an ordinary contract
 * rather than something with a second, CLI-shaped entrance.
 */
async function join(args: PublishArgs): Promise<ClusterNode> {
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

    return {
        waitFor: (tool: string, ms: number) => app.registry.waitForTool(tool, ms),
        call: (tool, params, options) => app.call(tool, params, options),
        stop: () => app.stop(),
    };
}
