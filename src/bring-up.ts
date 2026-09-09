/**
 * Bring a cluster up from nothing: an operator, a fleet, a catalog, a release, a hostname serving it.
 *
 * **Every step is a contract call, and every step is a function that can be called on its own.**
 * That is the point of the file rather than a tidiness preference — the pipeline it automates was
 * run by hand for weeks, and each stage was somewhere to get one argument wrong at eleven at night.
 *
 * ```
 * join     →  user, organization, membership, ticket   identity exists
 * assign   →  the node runs catalog, builder, cdn      the fleet decides, live, no restart
 * import   →  mesh.json read once, into part rows      the catalog knows what the parts are
 * release  →  pull, mint a version, publish, build     artifacts exist
 * compose  →  exact digests, marked rolling            a release
 * site     →  grants derived from what it calls        a hostname that may serve it
 * deploy   →  one field                                it does
 * ```
 *
 * **It joins; it does not load a database.** An earlier version mounted `DatabaseModule`, identity
 * and the cdn in-process and wrote rows directly — a second path into the same collections that
 * skipped every check the contracts exist to enforce, so what it seeded was not necessarily
 * something the platform would have accepted from a real caller.
 *
 * ```
 * node bin/node.mjs …            # the cluster, holding the database
 * npx tsx src/bring-up.ts        # this, dialling in on the default port
 * ```
 *
 * Every function is idempotent, and running it twice is how you find out that it is.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BrokerModule,
    JSONSerializer,
    MeshApp,
    NetworkModule,
    RegistryModule,
    type IServiceBroker,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const optional = (name: string): string | undefined => {
    const value = flag(name, '');
    return value === '' ? undefined : value;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

/**
 * The mesh handshake key comes from `.env`, like everything else a node needs.
 *
 * Not from a command line: a value typed as `MESH_KEY=… npx tsx …` is visible in `ps` to every user
 * on the machine and lands in a shell history. `bin/node.mjs` reads the same file for the same
 * reason, and a joiner whose key does not match the cluster's is refused at the transport.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
    // No `.env` is fine: a loopback cluster started without a key needs none, and an already
    // exported value wins anyway.
}

/** Where the cluster is. The node's own default ws port, so the common case needs no flag. */
const DEFAULT_BOOTSTRAP = 'ws://127.0.0.1:4001';

/** What a node runs beyond the always-on core, and therefore what the fleet gets to decide. */
const SWITCHABLE = ['catalog', 'builder', 'cdn', 'telem'] as const;

/**
 * How long to wait on a call that clones and bundles.
 *
 * The broker's default is 10 seconds, which is right for a question and wrong for work: releasing
 * mesh-core is seven clones and seven bundles and took 22 seconds on a warm machine. **The failure
 * that produced this constant is the one worth naming** — the caller timed out at ten seconds and
 * reported `RPC Timeout calling builder.release_repo`, while the builder carried on and finished
 * every part correctly. So the run *failed* and the work *succeeded*, which is the most confusing
 * pair of outcomes available: nothing was wrong, and nothing said so.
 *
 * Fifteen minutes rather than a tuned number. This bounds a hang; it does not schedule anything,
 * and a build that legitimately takes eleven minutes should not fail because somebody guessed ten.
 */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How long to wait for a node to actually take an assignment.
 *
 * Shorter than a build because nothing is fetched or compiled — a service is imported and
 * started — but far longer than the broker's 10s default, because the reconcile behind it is
 * several database round trips and a module load on another machine.
 */
const ASSIGN_TIMEOUT_MS = 90 * 1000;

export interface BringUpContext {
    app: MeshApp;
    broker: IServiceBroker;
    /** Block until a tool is reachable on the mesh, so a call cannot race the node that answers it. */
    waitFor(tool: string, ms?: number): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Who a call is made as.
 *
 * Built once by `callerFor` and threaded through every step below, because each of them writes
 * something that belongs to an organization and the platform is entitled to ask whose.
 */
export interface Caller {
    // Not `readonly`, and not a hand-written shape: this is passed straight to `broker.call` as its
    // options, so it has to *be* `ICallOptions`. Deep-readonly fields are structurally incompatible
    // with it, which is a compile error that says nothing about the actual mistake.
    meta: {
        organizationId: string;
        tenantId: string;
        user: { id: string; tenant_id: string; roles: string[] };
    };
}

// ---------------------------------------------------------------------------- joining

/**
 * Join the cluster as a temporary node.
 *
 * `port: 0` because this node dials out and nothing dials it — a peer that happens to be
 * short-lived rather than a client, which is what lets every contract it calls be an ordinary
 * contract with no second, script-shaped entrance.
 */
export async function setup(options: { bootstrap?: readonly string[] } = {}): Promise<BringUpContext> {
    const configured = options.bootstrap
        ?? (flag('bootstrap', process.env['MESH_BOOTSTRAP'] ?? DEFAULT_BOOTSTRAP))
            .split(',').map((node) => node.trim()).filter((node) => node !== '');

    const app = new MeshApp({
        nodeID: `bringup-${os.hostname()}-${Date.now().toString(36)}`,
    });

    app.use(new RegistryModule());
    app.use(new NetworkModule({
        port: 0,
        transports: [new WSTransport(new JSONSerializer(), 0)],
        bootstrapNodes: [...configured],
    }));
    app.use(new BrokerModule());

    await app.start();

    return {
        app,
        broker: app.getProvider<IServiceBroker>('broker'),
        waitFor: (tool, ms = 10_000) => app.registry.waitForTool(tool, ms),
        stop: () => app.stop(),
    };
}

// ---------------------------------------------------------------------------- identity

/** The user: created on the first run, found on every one after. */
export async function ensureUser(
    ctx: BringUpContext,
    account: { email: string; password: string; displayName: string },
): Promise<string> {
    await ctx.waitFor('identity.register');

    const existing = await ctx.broker.call('user.find_one', { query: { email: account.email } })
        .catch(() => null);

    if (existing?.id !== undefined) {
        console.log(`[user] "${account.email}" already exists (${existing.id})`);
        return existing.id;
    }

    const registered = await ctx.broker.call('identity.register', account);
    console.log(`[user] registered "${account.email}" (${registered.userId})`);
    return registered.userId;
}

/** The organization every row below belongs to. */
export async function ensureOrganization(
    ctx: BringUpContext,
    org: { slug: string; name: string; ownerId: string },
): Promise<string> {
    const existing = await ctx.broker.call('organization.find_one', { query: { slug: org.slug } })
        .catch(() => null);

    if (existing?.id !== undefined) {
        console.log(`[org] "${org.slug}" already exists (${existing.id})`);
        return existing.id;
    }

    const created = await ctx.broker.call('organization.create', {
        name: org.name, slug: org.slug, ownerId: org.ownerId,
    });
    console.log(`[org] created "${org.name}" (${org.slug}) (${created.id})`);
    return created.id;
}

/** The membership, which is what makes this user's calls resolve to that organization. */
export async function ensureMembership(
    ctx: BringUpContext,
    who: { userId: string; orgId: string },
    as: Caller,
): Promise<void> {
    // **Both halves of the key.** Querying on `userId` alone matches a membership in *some*
    // organization, so a user who belongs to two would be reported as already a member of whichever
    // row came back first — and never added to this one.
    const existing = await ctx.broker.call(
        'membership.find_one',
        { query: { userId: who.userId, organizationId: who.orgId } },
        as,
    ).catch(() => null);

    if (existing?.id !== undefined) {
        console.log('[membership] already an owner');
        return;
    }

    await ctx.broker.call('membership.create', {
        userId: who.userId, organizationId: who.orgId, roleKey: 'owner', joinedAt: Date.now(),
    }, as);
    console.log(`[membership] added ${who.userId} as owner`);

    /**
     * **A second membership is not free, and nothing used to say so.**
     *
     * The `authorize` hook resolves a scope from the caller's memberships and will only do it when
     * there is exactly one — with more it declines rather than guessing, because guessing which
     * organization a request meant is how it reads the wrong one's data. So the moment an account
     * joins its second organization, every *scoped* collection starts answering 401 over HTTP until
     * the caller sends `x-organization`, while the global ones carry on working.
     *
     * That is correct and it looks nothing like the truth from a browser: the console showed
     * "no auth" on sites and releases and loaded parts and nodes normally. Adding the membership is
     * still the right thing to do here — it is what makes the account able to work in the
     * organization at all — so this warns rather than refuses.
     */
    const all = await ctx.broker.call(
        'membership.find', { query: { userId: who.userId }, limit: 50 }, as,
    ).catch(() => []);

    if (all.length > 1) {
        console.warn(
            `[membership] this account is now in ${String(all.length)} organizations. Scoped ` +
            `collections (site, release) will answer 401 over HTTP until the caller sends the ` +
            `x-organization header, because the scope is ambiguous and the hook will not guess.`,
        );
    }
}

/**
 * Who this script's calls are made as.
 *
 * **The operator role is asserted in the meta this process constructs**, not written onto the user
 * row. An earlier version called `user.update` to grant it and failed with *user not found* against
 * an id it had just read successfully — identity keeps its own store, so the generic CRUD path
 * cannot write there, and the failure was swallowed by a `.catch`.
 *
 * Asserting it is not a smaller claim than writing it, and it is worth being plain about why it is
 * accepted here: **any peer that can join this mesh can construct any meta it likes.** Nothing
 * checks a caller's roles against a stored user; `requireOperator` reads what the caller said about
 * itself. The boundary that actually holds is `MESH_KEY` — a process without it is refused at the
 * transport and never makes a call at all. That is a real gap rather than a design, and it is
 * recorded as roadmap D6 rather than papered over by having this script pretend otherwise.
 */
export function callerFor(
    userId: string,
    orgId: string,
    roles: readonly string[] = ['operator'],
): Caller {
    return {
        meta: {
            organizationId: orgId,
            tenantId: orgId,
            user: { id: userId, tenant_id: orgId, roles: [...roles] },
        },
    };
}

/** A ticket, so whatever the operator does next is a call from a real caller. */
export async function issueTicket(
    ctx: BringUpContext,
    credentials: { email: string; password: string },
): Promise<string> {
    await ctx.waitFor('identity.ticket_issue');
    const issued = await ctx.broker.call('identity.ticket_issue', credentials);
    return issued.token;
}

// ---------------------------------------------------------------------------- the fleet

/**
 * Tell a node what to run, and wait until it is running it.
 *
 * `catalog`, `builder` and `cdn` are **switchable**: a node starts only its core services (api,
 * identity, fleet, supervisor) until the fleet assigns the rest, and the Supervisor starts them
 * live without a restart. So this is not configuration — it is the step that makes every call
 * below this line possible at all.
 *
 * Waiting afterwards is the part that is easy to omit and expensive to omit. `node.assign` returns
 * as soon as the node has been *told*; a build request sent a millisecond later fails with *tool
 * not found* on a cluster that is working perfectly.
 */
export async function assignServices(
    ctx: BringUpContext,
    as: Caller,
    options: { hostname?: string; services?: readonly string[] } = {},
): Promise<{ hostname: string; services: readonly string[] }> {
    await ctx.waitFor('node.assign');

    const hostname = options.hostname ?? await targetNode(ctx, as);
    const services = options.services ?? SWITCHABLE;

    console.log(`[fleet] assigning [${services.join(', ')}] to "${hostname}"`);

    /**
     * **Assigning is work, not a question**, so it does not get a question's timeout.
     *
     * `node.assign` writes the desired state, then reconciles: the target node's Supervisor starts
     * or stops each service, live. Against a remote database every one of those steps is a
     * round trip, and the whole thing overran the broker's 10s default the first time it was asked
     * to start a builder — reported as `RPC Timeout calling node.assign`, while the assignment
     * itself went on to succeed. Exactly the failure the build timeout exists for, one call earlier.
     */
    const outcome = await ctx.broker.call('node.assign', {
        hostname, services: [...services],
    }, { ...as, timeout: ASSIGN_TIMEOUT_MS });
    console.log(`[fleet] "${hostname}" assigned (applied: ${String(outcome.applied)})`);

    // One tool per service, and each is the *last* thing that service registers rather than a name
    // that happens to live in the same file — waiting on an early one reports ready too soon.
    const readiness: Record<string, string> = {
        builder: 'builder.release_repo',
        catalog: 'catalog.resolve',
        cdn: 'cdn.site_edit',
        telem: 'telem.query',
    };

    for (const service of services) {
        const tool = readiness[service];
        if (tool === undefined) continue;
        await ctx.waitFor(tool, 30_000);
        console.log(`[fleet] ${service} is up`);
    }

    return { hostname, services };
}

/**
 * Which machine to assign to, when nobody said.
 *
 * The fleet's own record first, because a node that has said hello is a node that exists. The
 * registry is the fallback, so the very first run works on a cluster with no `node` rows at all —
 * and this process's own peer is excluded either way, since assigning services to the bring-up
 * script would be assigning them to something that is about to exit.
 */
async function targetNode(ctx: BringUpContext, as: Caller): Promise<string> {
    const known = await ctx.broker.call('node.find', { query: {}, limit: 50 }, as).catch(() => []);
    const registered = known.find((node) => !node.hostname.startsWith('bringup-'));
    if (registered !== undefined) return registered.hostname;

    const peers = ctx.app.registry.getNodes?.() ?? [];
    const peer = peers.find((node) => !node.nodeID.startsWith('bringup-'));
    return peer?.nodeID ?? os.hostname();
}

// ---------------------------------------------------------------------------- catalog and builder

/**
 * Read a repository's descriptor into part rows. **The last thing that reads `mesh.json`.**
 *
 * After this the catalog is authoritative: what a part builds, which entry, which kernel range and
 * which contracts it calls all live on the row and are editable from the console. Editing the file
 * again changes nothing until somebody imports again, which is the coupling being removed rather
 * than an oversight.
 */
export async function importRepository(
    ctx: BringUpContext,
    as: Caller,
    options: { repository: string; ref?: string },
): Promise<readonly { name: string; kind: string; version?: string }[]> {
    console.log(
        `[builder] importing ${options.repository}` +
        `${options.ref === undefined ? '' : ` @ ${options.ref}`}`,
    );

    const imported = await ctx.broker.call('builder.import_repo', {
        repository: options.repository,
        // Absent means the repository's own default branch, whatever it is called. Naming `main`
        // here is a guess about somebody else's repository, and it was wrong the first time it ran.
        ...(options.ref === undefined ? {} : { ref: options.ref }),
    }, { ...as, timeout: BUILD_TIMEOUT_MS }).catch((error: unknown) => {
        /**
         * **"No such part." means somebody else's part, and only here can that be said.**
         *
         * `catalog.declare` answers 404 rather than 403 when a part of that name exists under a
         * different publisher, deliberately: *which organization publishes a part* is not something
         * an unrelated caller gets to confirm by probing. That refusal is right and stays.
         *
         * But this caller is not unrelated — it is the operator seeding their own cluster, and to
         * them the message reads as *the repository is wrong*, which sends them to check a URL that
         * was never the problem. Seeding a **second organization** against a catalog that already
         * holds parts hits it every time, and the parts belong to whichever organization seeded
         * first.
         *
         * So the situation is named here, where it is knowable, without the platform telling
         * anybody anything it would not tell a stranger.
         */
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('No such part')) throw error;

        throw new Error(
            `${options.repository} declares a part this catalog already holds under a different `
            + `organization.\n\n`
            + `  A part belongs to the organization that first published it, and this run is `
            + `seeding a different one.\n`
            + `  Either seed as the organization that owns them (--org-slug <theirs>), or start `
            + `against an empty database (--db <a new name>).`,
        );
    });

    for (const part of imported.parts) {
        console.log(`[builder]   ${part.kind} ${part.name} ${part.existed ? 'updated' : 'declared'}`);
    }
    return imported.parts;
}

/**
 * Release every part a repository declares: pull, mint a version, publish, build.
 *
 * Kernels first — the contract handles that, and it matters: a part declares a kernel range, so a
 * kernel released after the parts written against it leaves a set nobody can compose.
 *
 * Failures are reported rather than thrown, by the contract and again here. Seven parts should give
 * seven answers, and one that cannot build is a thing to read, not a reason to abandon the six that
 * can.
 */
export async function releaseRepository(
    ctx: BringUpContext,
    as: Caller,
    options: {
        repository: string;
        bump?: 'patch' | 'minor' | 'major';
        branch?: string;
        /**
         * Pin one part's label instead of minting it — in practice, the kernel's.
         *
         * **Minted labels and declared ranges can come apart, and for the kernel that is fatal.**
         * Every other part declares `kernel: ^0.15`, meaning the kernel's *real* version. The
         * catalog mints from its own sequence, which had reached `0.16.0` from an earlier
         * deployment, so the same commit was published as `0.16.1` — correct by the catalog's
         * rules, and unsatisfiable by every part that names it.
         *
         * A part nobody depends on can carry any label. The kernel cannot, so its label is pinned
         * to what it actually is. Relabelling is cheap and lossless: `(partName, commit)` is the
         * identity, so this moves the label on the existing row and touches neither the artifact
         * nor any release already pinning its digest.
         */
        readonly pin?: Readonly<Record<string, string>>;
    },
): Promise<{ released: readonly { part: string; version: string }[]; failed: number }> {
    console.log(`[builder] releasing ${options.repository}`);

    /**
     * A pinned part is released on its own, because `release_repo` mints for everything it does.
     * Everything else in the repository still goes through the batch, which is what orders kernels
     * first and collects failures.
     */
    for (const [part, version] of Object.entries(options.pin ?? {})) {
        const pinned = await ctx.broker.call('builder.release_part', {
            part, version, bump: 'patch',
            ...(options.branch === undefined ? {} : { branch: options.branch }),
        }, { ...as, timeout: BUILD_TIMEOUT_MS }).catch((error: unknown) => {
            console.error(`[builder]   ${part} pinned release FAILED — ${String(error)}`);
            return undefined;
        });
        if (pinned !== undefined) {
            console.log(`[builder]   ${pinned.part}@${pinned.version} ${pinned.commit.slice(0, 12)} (pinned)`);
        }
    }

    const result = await ctx.broker.call('builder.release_repo', {
        repository: options.repository,
        bump: options.bump ?? 'patch',
        ...(options.branch === undefined ? {} : { branch: options.branch }),
    }, { ...as, timeout: BUILD_TIMEOUT_MS });

    for (const part of result.released) {
        console.log(
            `[builder]   ${part.part}@${part.version} ${part.commit.slice(0, 12)}` +
            `${part.cached ? ' (cached)' : ''}`,
        );
    }
    for (const failure of result.failed) {
        console.error(`[builder]   ${failure.part} FAILED — ${failure.reason}`);
    }

    return { released: result.released, failed: result.failed.length };
}

// ---------------------------------------------------------------------------- the site's grants

/**
 * What gate a contract goes behind, when nobody has said otherwise.
 *
 * **A part must never choose its own gate**, so this is the site owner's policy written once rather
 * than typed out per contract. The shape of it is the interesting part:
 *
 * - `public` — the two calls a signed-out browser must make. Not *harmless*, not *read-only*:
 *   **required in order to sign in at all**, which is the only thing that earns `public`.
 * - `user` — reading.
 * - `operator` — everything that changes what runs on a hostname: composing, deploying, releasing,
 *   assigning a node its services.
 *
 * The default is `operator`, deliberately. A contract this table has not been taught about is one
 * nobody has classified, and the safe answer to *I do not know what this does* is the strictest
 * gate — a too-strict gate is a 403 somebody reports, a too-loose one is not noticed.
 */
export function gateFor(key: string): 'public' | 'user' | 'admin' | 'operator' {
    const PUBLIC = new Set([
        'identity.register',
        'identity.ticket_issue',
        /**
         * **Public because the failures worth recording happen before anyone signs in.**
         *
         * A page that cannot boot, a part that throws on mount, a call refused for want of a
         * session — every one of those happens to an anonymous browser, and gating telemetry at
         * `user` would collect nothing from precisely the sessions somebody needs to see.
         *
         * `public` is not free here and the server is what makes it affordable: `telem.ingest`
         * bounds a batch at 100 events, rate-limits per session and per host, and stores keys and
         * outcomes rather than inputs. The gate is open; the door is narrow.
         */
        'telem.ingest',
    ]);
    if (PUBLIC.has(key)) return 'public';

    const USER = new Set([
        'identity.whoami', 'identity.sign_out', 'identity.ticket_revoke',
        'catalog.resolve', 'builder.get_artifact', 'builder.artifact_blob',
    ]);
    if (USER.has(key)) return 'user';

    /**
     * **The fleet answers operators, including its reads.**
     *
     * `node.status` was in the `user` set above and that was wrong in the way that is hardest to
     * see: the site let the request through the gate, and then `requireOperator` inside the handler
     * refused it — a 403 on a call the site had promised a signed-in user could make. The gate and
     * the contract disagreed, and the gate is the half a person configures.
     *
     * A gate can be stricter than a handler safely; the reverse is a promise the platform will not
     * keep. So everything the fleet owns matches what its handlers actually demand — what machines
     * exist and what each is running is operator business either way.
     */
    if (/^(node|group)\./.test(key)) return 'operator';

    /**
     * Generated reads.
     *
     * Safe **only where the collection declares `scopedBy`**, which narrows a find to the caller's
     * organization so it cannot be widened into somebody else's data. That is true of `site` and is
     * *not* true of `release`, whose own comment claims otherwise — roadmap D7. This line is
     * therefore slightly ahead of the platform, and the note is here so it is not mistaken for a
     * guarantee: fixing D7 is what makes it one.
     */
    if (/\.(find|find_one|get|count)$/.test(key)) return 'user';

    return 'operator';
}

/**
 * The site's grants, derived from what the deployed release actually calls.
 *
 * **Not a hand-written list**, which matters more than it looks. `cdn.deploy` refuses a release
 * calling a contract the site does not expose — correctly, since the alternative is a 404 at run
 * time found by whoever opens the page — so a maintained-by-hand list goes stale exactly when a new
 * part is added, which is the moment somebody is least able to guess why the deploy was refused.
 *
 * Three are added whether or not a part declares them. `identity.register` and
 * `identity.ticket_issue`, because a page nobody can sign in to cannot use anything else it was
 * granted — and `telem.ingest`, for a reason that is nearly the same and easy to miss.
 *
 * **A grant derived from `release.requires` can never bootstrap telemetry.** The parts worth
 * hearing from are the ones failing to mount, and a part that fails to mount does not get to
 * declare anything. Worse, the useful failures are on *first* deploy, before any part has declared
 * a dependency on it. So it is granted up front, exactly like signing in: a capability the page
 * needs in order for the rest of the page to be diagnosable at all.
 */
export function grantsFor(requires: readonly string[]): {
    contracts: { key: string; auth: 'public' | 'user' | 'admin' | 'operator' }[];
    events: { key: string; auth: 'public' | 'user' | 'admin' | 'operator' }[];
} {
    const keys = new Set([
        ...requires,
        'identity.register',
        'identity.ticket_issue',
        'telem.ingest',
    ]);
    const contracts = [...keys].sort().map((key) => ({ key, auth: gateFor(key) }));

    /**
     * Every exposed collection streams its own CRUD events, at the gate its `find` has.
     *
     * This is what makes a list in the console *live* rather than a snapshot with a refresh button
     * beside it: mesh-web subscribes to `${name}.created|updated|deleted` for a collection the
     * generated client declares, and the client declares only what the site exposes. The gate has
     * to match the collection's own — looser would push rows to somebody who may not read them.
     */
    const domains = [...new Set(
        contracts
            .filter((entry) => entry.key.endsWith('.find'))
            .map((entry) => entry.key.slice(0, entry.key.indexOf('.'))),
    )].sort();

    const events = domains.flatMap((domain) => ['created', 'updated', 'deleted'].map((verb) => ({
        key: `${domain}.${verb}`,
        auth: gateFor(`${domain}.find`),
    })));

    return { contracts, events };
}

// ---------------------------------------------------------------------------- releases and sites

/**
 * Compose a release from ranges, and mark it rolling.
 *
 * **Ranges rather than the exact versions just minted.** A release marked `rolling` re-resolves
 * *these* when a part in them is released again, which is the last two steps of the old six-step
 * loop happening without anybody typing them. Pinning what came out of this run would make the
 * release follow nothing.
 */
export async function composeRelease(
    ctx: BringUpContext,
    as: Caller,
    options: {
        kernel: string;
        parts: readonly { kind: 'application' | 'extension'; id: string; version: string }[];
        name?: string;
        rolling?: boolean;
    },
): Promise<{ hash: string; requires: readonly string[] } | undefined> {
    await ctx.waitFor('cdn.compose');

    const composed = await ctx.broker.call('cdn.compose', {
        kernel: options.kernel,
        parts: options.parts.map((part) => ({ ...part })),
        name: options.name ?? '',
        rolling: options.rolling ?? true,
    }, as);

    if (composed.hash === '') {
        // Every problem at once: somebody composing seven parts wants seven answers, and failing on
        // the first turns one round trip into seven.
        console.error('[cdn] composition failed:');
        for (const problem of composed.problems) console.error(`[cdn]   ${problem.message}`);
        return undefined;
    }

    console.log(
        `[cdn] release ${composed.hash} — kernel ${composed.kernel.version}, ` +
        `${String(Object.keys(composed.parts).length)} part(s)` +
        `${composed.existed ? ' (existed)' : ''}`,
    );

    // The row carries the union of what its parts call, which is exactly what the site must grant.
    const release = await ctx.broker.call('release.find_one', { query: { hash: composed.hash } }, as);
    return { hash: composed.hash, requires: release?.requires ?? [] };
}

/** The site, with grants covering exactly what the release calls. */
export async function ensureSite(
    ctx: BringUpContext,
    as: Caller,
    options: {
        host: string;
        api: string;
        application: string;
        tenantId: string;
        requires: readonly string[];
        title?: string;
    },
): Promise<string> {
    const { contracts, events } = grantsFor(options.requires);
    const mesh = [{
        package: '@flybyme/mesh-serve',
        version: '^0.1.0',
        contracts,
        events,
    }];

    const existing = await ctx.broker.call('site.find_one', { query: { host: options.host } }, as)
        .catch(() => null);

    if (existing?.id !== undefined) {
        // Grants are rewritten every run *because they are derived*: a release that calls something
        // new must not need a person to remember. Everything else about the site — theme, policy,
        // title — is left exactly as the operator set it.
        await ctx.broker.call('site.update', {
            id: existing.id, mesh, api: options.api,
        }, as);
        console.log(
            `[site] "${options.host}" updated — ${String(contracts.length)} contract(s), ` +
            `${String(events.length)} event(s)`,
        );
        return existing.id;
    }

    const created = await ctx.broker.call('site.create', {
        host: options.host,
        application: options.application,
        tenantId: options.tenantId,
        api: options.api,
        mesh,
        theme: {},
        policy: {},
        title: options.title ?? options.application,
    }, as);

    console.log(
        `[site] created "${options.host}" (${created.id}) — ${String(contracts.length)} contract(s), ` +
        `${String(events.length)} event(s)`,
    );
    return created.id;
}

/** Point the hostname at the release. One field, which is why rollback is the same write backwards. */
export async function deploySite(
    ctx: BringUpContext,
    as: Caller,
    options: { host: string; release: string },
): Promise<void> {
    const deployed = await ctx.broker.call('cdn.deploy', {
        host: options.host, release: options.release,
    }, as);

    console.log(
        `[cdn] ${deployed.host} → ${deployed.release}${deployed.changed ? '' : ' (unchanged)'}`,
    );

    if (deployed.unusedGrants.length > 0) {
        // Reported, never refused: a grant nothing calls is the route somebody left behind when
        // they deleted the screen that used it.
        console.log(`[cdn] granted but unused: ${deployed.unusedGrants.join(', ')}`);
    }
}

// ---------------------------------------------------------------------------- the whole thing

/**
 * What the console is made of.
 *
 * Ranges, because the release is rolling: these are what it re-resolves when any of these parts is
 * released again.
 */
/**
 * The range that follows a minted version.
 *
 * `0.1.0` → `^0.1`, so a rolling release picks up every later patch of that line and stops at the
 * next minor — which is what a caret means for a `0.x` version, and what somebody shipping
 * pre-1.0 code actually wants.
 *
 * **Derived rather than written down, and that is the whole point.** This file listed the ranges
 * by hand — `chrome ^0.2`, `auth ^0.3` — copied from a catalog that already had a version history.
 * Against a *fresh* database every part mints at `0.1.0`, so every one of those ranges matched
 * nothing and compose would have refused seven parts in a row, a few seconds after seven builds
 * had visibly succeeded. A bring-up script that only works on a database that has already been
 * brought up is not one.
 */
export function rangeFor(version: string): string {
    const [major, minor] = version.split('.');
    return major === undefined || minor === undefined ? `^${version}` : `^${major}.${minor}`;
}

export async function main(): Promise<void> {
    const ctx = await setup();

    try {
        console.log('\n=== Seeding the cluster through its own contracts ===\n');

        const email = flag('email', process.env['USER_EMAIL'] ?? 'tim@example.com');
        const password = flag('password', process.env['USER_PASSWORD'] ?? 'correct-horse-battery-staple');

        const userId = await ensureUser(ctx, {
            email,
            password,
            displayName: flag('name', process.env['USER_NAME'] ?? 'Tim'),
        });
        /**
         * **The organization is named, never invented.**
         *
         * This defaulted to `tim-org`, and against a cluster that already had one it did real
         * damage rather than nothing. It created a second organization, added the account to it,
         * and every `catalog.declare` was then refused with *No such part* — correctly, because the
         * parts belonged to `flybyme` and the caller was now arriving as somebody else.
         *
         * Worse and quieter: two memberships make the scope **ambiguous**, and the `authorize` hook
         * resolves one only when there is exactly one — it will not guess, because guessing is how
         * a request reads another organization's data. So every *scoped* collection started
         * answering 401 while the global ones kept working, which reads as an auth bug and is a
         * membership bug. Undoing it meant deleting a membership from a live database.
         *
         * A default that is harmless on an empty cluster and destructive on a real one is not a
         * default. Refused, with the organizations that do exist named, because the answer is
         * almost always already on screen.
         */
        const orgSlug = optional('org-slug') ?? process.env['ORG_SLUG'];
        if (orgSlug === undefined) {
            const known = await ctx.broker.call('organization.find', { query: {}, limit: 50 })
                .catch(() => []);
            console.error(
                `\nWhich organization? Pass --org-slug.\n` +
                (known.length === 0
                    ? '  none exist yet — pass --org-slug and --org-name to create one\n'
                    : `  existing: ${known.map((o) => o.slug).join(', ')}\n`),
            );
            return;
        }

        const orgId = await ensureOrganization(ctx, {
            slug: orgSlug,
            // Only used when creating; an existing organization keeps the name it has.
            name: flag('org-name', process.env['ORG_NAME'] ?? orgSlug),
            ownerId: userId,
        });

        const as = callerFor(userId, orgId);
        await ensureMembership(ctx, { userId, orgId }, as);
        const ticket = await issueTicket(ctx, { email, password });

        const host = flag('host', process.env['SITE_HOST'] ?? 'localhost');
        const api = flag('api', process.env['SITE_API'] ?? 'http://127.0.0.1:5005');

        // `--identity-only` stops here: an account and a ticket, nothing built. What you want when
        // the cluster is already seeded and you only need to be able to sign in.
        if (has('identity-only')) {
            report({ email, orgId, ticket });
            return;
        }

        /**
         * Which machine runs what, and **why this is a flag rather than a constant.**
         *
         * `builder.build_start` declares `requirements: { memory: 2048 }` and refuses below it with
         * a 507. surf has 981MB. So assigning the default set to surf produces a node that accepts
         * `catalog` and `cdn` and then declines every single build — correctly, and confusingly, in
         * the middle of a bring-up that looked like it was working.
         *
         *     --services catalog,cdn        on a small public node
         *     --services builder            on a box with the memory for it
         *
         * The refusal is the fix for an earlier failure, not a new limitation: builds used to
         * round-robin onto surf, which then missed its pings mid-bundle and dropped off the mesh.
         */
        const node = optional('node');
        const services = optional('services')?.split(',').map((s) => s.trim()).filter((s) => s !== '');

        await assignServices(ctx, as, {
            ...(node === undefined ? {} : { hostname: node }),
            ...(services === undefined ? {} : { services }),
        });

        /**
         * The kernel repository first, then everything built against it.
         *
         * `release_repo` orders parts within one repository, but two repositories have an order
         * too: mesh-core's parts declare a kernel range, and composing against a kernel with no
         * artifact yet is a refusal that reads as a missing part.
         */
        /**
         * **Two repositories are this platform's own; `--app-repo` is anybody else's.**
         *
         * The kernel and core were hardcoded because bring-up was written to seed *this* platform
         * from *its* repositories, and a third-party site was never a path through it. That is the
         * wall the first outside user hit: flowboard exists, the platform can serve it, and there
         * was no way to tell the seed it existed.
         *
         * Order matters and is not alphabetical. The kernel is imported first because everything
         * else declares a range against it, and an app comes last because it may declare
         * `requiredParts` against core's extensions.
         *
         * A repository is a **reference**, never a path — `src/builder/methods/source.ts` enforces
         * that, and it is the rule that stops a build ever happening "wherever the code already is".
         * A local *bare* repository satisfies it: the builder still clones one commit into a
         * workspace it chose. So `--app-repo ~/code/.git-remotes/flowboard.git` is a legitimate
         * development answer and does not weaken anything; a working directory is not.
         */
        const repositories = [
            flag('kernel-repo', 'https://github.com/FLYBYME/mesh-web.git'),
            flag('core-repo', 'https://github.com/FLYBYME/mesh-core.git'),
            ...(optional('app-repo') === undefined ? [] : [optional('app-repo') as string]),
        ];
        const ref = optional('ref');

        /**
         * What each repository declared, and what each release actually minted.
         *
         * Kept because the composition is built from them: `import` knows a part's `kind`, `release`
         * knows the version it chose, and only together do they say what to compose. Neither is
         * something this file may assume.
         */
        const kinds = new Map<string, string>();
        const versions = new Map<string, string>();

        let failures = 0;
        for (const repository of repositories) {
            const declared = await importRepository(ctx, as, {
                repository, ...(ref === undefined ? {} : { ref }),
            });
            for (const part of declared) kinds.set(part.name, part.kind);

            if (has('import-only')) continue;

            /**
             * The kernel's label is pinned to its real version when one is given.
             *
             * `--kernel-version 0.15.11 --kernel-range ^0.15` is the shape: the kernel is the one
             * part every other part names a range against, so its label has to mean what the parts
             * think it means. Everything else is minted.
             */
            /**
             * **Defaulted from what the kernel declares, rather than typed.**
             *
             * `--kernel-version` still wins, but needing it was the bug: a fresh cluster composed
             * eight parts asking for `kernel: ^0.15` against a kernel the catalog had minted
             * `0.1.0`, and refused — correctly, and unfixably unless you had read this file and
             * knew the flag existed.
             *
             * `import_repo` now reports a kernel's declared version for exactly this, so the number
             * comes from the repository that owns it instead of from somebody's memory.
             */
            const kernelPart = [...kinds].find(([, kind]) => kind === 'kernel')?.[0];
            const kernelDeclared = declared.find((part) => part.kind === 'kernel')?.version;
            const pinnedKernel = optional('kernel-version') ?? kernelDeclared;
            const pin = pinnedKernel !== undefined && kernelPart !== undefined
                && declared.some((part) => part.name === kernelPart)
                ? { [kernelPart]: pinnedKernel }
                : undefined;

            const result = await releaseRepository(ctx, as, {
                repository,
                bump: 'patch',
                ...(ref === undefined ? {} : { branch: ref }),
                ...(pin === undefined ? {} : { pin }),
            });
            for (const part of result.released) versions.set(part.part, part.version);
            failures += result.failed;
        }

        // `--import-only` stops once the catalog knows what the parts are — useful on a slow
        // connection, or to look at what was declared before anything is built.
        if (has('import-only')) {
            report({ email, orgId, ticket });
            return;
        }

        if (failures > 0) {
            // Composing on top of a partial release produces a second, more confusing failure about
            // a missing artifact, several steps away from the build that actually failed.
            console.error(
                `\n${String(failures)} part(s) failed to build. Nothing was composed — fix those ` +
                `first, then run this again.\n`,
            );
            report({ email, orgId, ticket });
            return;
        }

        /**
         * The composition, built from what was just released rather than from a list in this file.
         *
         * The kernel is separated out because a release names exactly one, as a range, and it is
         * not one of the `parts`. Everything else goes in at the caret of its own minted version,
         * so the release rolls forward within that line.
         */
        const kernelName = [...kinds].find(([, kind]) => kind === 'kernel')?.[0];
        const kernelVersion = kernelName === undefined ? undefined : versions.get(kernelName);

        if (kernelVersion === undefined) {
            console.error(
                '\nNo kernel was released, so there is nothing to compose against. The kernel ' +
                'repository is the first one imported; check what it declared above.\n',
            );
            report({ email, orgId, ticket });
            return;
        }

        /**
         * **`--parts` composes a subset; absent, everything imported goes in.**
         *
         * A release is *"a kernel and N parts at exact digests"*, and which N is a decision about
         * the site — not a consequence of what happens to be in the catalog. Composing everything
         * is right for seeding this platform's own console, and wrong for every other site: the
         * first outside application landed on a page titled `Console` that booted nine parts, eight
         * of which were somebody else's consoles.
         *
         * `--parts flowboard` is the site that is only flowboard. The kernel is never listed —
         * every release has exactly one and it is named separately.
         */
        const only = optional('parts')?.split(',').map((p) => p.trim()).filter((p) => p !== '');

        const parts = [...versions]
            .filter(([name]) => name !== kernelName)
            .filter(([name]) => only === undefined || only.includes(name))
            .map(([name, version]) => ({
                // A part is an application or an extension; the catalog said which at import.
                kind: (kinds.get(name) === 'application' ? 'application' : 'extension') as
                    'application' | 'extension',
                id: name,
                version: rangeFor(version),
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));

        // Resolved once and both used and printed, because these were two expressions and the log
        // rendered the derived range while the call used the override — so it reported composing
        // `^0.16` while composing `^0.15`, and the release that came back was a kernel the line on
        // screen said had not been asked for.
        const kernelRange = optional('kernel-range') ?? rangeFor(kernelVersion);

        console.log(
            `[cdn] composing kernel ${kernelRange} with ` +
            `${String(parts.length)} part(s): ${parts.map((p) => `${p.id}@${p.version}`).join(', ')}`,
        );

        const composed = await composeRelease(ctx, as, {
            kernel: kernelRange,
            parts,
            // The release is named after what it is. `console` was hardcoded, which is why a site
            // holding one application called flowboard served a page titled Console.
            // `--release-name`, not `--name`: that one is already the operator's display name, and
            // two meanings for one flag is a bug waiting for somebody in a hurry.
            name: flag('release-name', only?.length === 1 ? (only[0] ?? 'console') : 'console'),
            rolling: true,
        });

        if (composed === undefined) {
            console.error('\nNothing was deployed: the composition above has to hold together first.\n');
            report({ email, orgId, ticket });
            return;
        }

        /**
         * The site is named after what it serves.
         *
         * `application` and `title` were both hardcoded `console`, so a site holding one application
         * called flowboard served a page whose `<title>` said Console — which is what a person sees
         * in a tab, and it was wrong for every site except this platform's own.
         *
         * A single `--parts` names it; anything else keeps the old default, because a release of
         * nine consoles genuinely is one.
         */
        const application = flag('application', only?.length === 1 ? (only[0] ?? 'console') : 'console');

        await ensureSite(ctx, as, {
            host,
            api,
            application,
            tenantId: orgId,
            requires: composed.requires,
            title: flag('title', application === 'console'
                ? 'Console'
                : application.charAt(0).toUpperCase() + application.slice(1)),
        });

        await deploySite(ctx, as, { host, release: composed.hash });

        report({ email, orgId, ticket, host, api, release: composed.hash });
    } finally {
        await ctx.stop();
    }
}

/**
 * The ticket is printed and the password is not.
 *
 * A ticket expires and can be revoked; a password is the credential behind every ticket that will
 * ever be issued for that account, and printing one puts it in a scrollback, a screen recording and
 * a `journalctl` for as long as any of those live. Same class of mistake as the database password
 * that reached surf's journal.
 */
function report(what: {
    email: string; orgId: string; ticket: string;
    host?: string; api?: string; release?: string;
}): void {
    console.log('\n=== Done ===\n');
    console.log(`User:    ${what.email}`);
    console.log(`Org:     ${what.orgId}`);
    if (what.host !== undefined) console.log(`Site:    ${what.host} → ${what.api ?? ''}`);
    if (what.release !== undefined) console.log(`Release: ${what.release}`);
    console.log(`\nTicket:  ${what.ticket}\n`);

    if (what.host !== undefined && what.api !== undefined) {
        console.log('Try it:');
        console.log(
            `  curl -H "Host: ${what.host}" -H "Authorization: Bearer ${what.ticket}" ` +
            `${what.api}/identity/whoami\n`,
        );
    }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error: unknown) => {
        console.error('Bring-up failed:', error);
        process.exit(1);
    });
}
