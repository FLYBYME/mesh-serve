import type { IServiceBroker } from '@flybyme/mesh';

/**
 * The hostname a fresh install's bootstrap api lives on -- not special-cased in routing any more
 * (every host, including this one, resolves through the same `serve.api` lookup), just the one this
 * install creates a real `serve.api` row for automatically, attached to the "platform" organization
 * `src/bootstrap.ts` creates on first claim. A literal string shared between the two files, the same
 * way the "operator" role key already is.
 */
export const BOOTSTRAP_API_HOST = process.env.DEFAULT_API_HOST ?? 'api.localhost';

/**
 * Exposed on the bootstrap api the moment it's created.
 *
 * Two groups. The first is how a fresh install gets anyone in at all: register, log in, ask who you
 * are, set a real password, and resolve an api's own id/tenant from its hostname. Those are public
 * (no role) because they are reads of non-sensitive routing data, or the login itself -- the same
 * standing `serve.cdn.resolveHost` already has, for the same "a caller who has nothing else yet"
 * reason.
 *
 * The second is the management surface: everything needed to bring a site up -- repos, parts,
 * artifacts, compositions, sites, apis and their exposure -- each gated on `operator`. This api is
 * the *management* api, and that is something its rows make true rather than a kind it is: nothing
 * structurally marks an api as managerial, and an application api like `my-app-api.localhost`
 * simply has none of these rows, so these calls 404 there rather than being forbidden.
 */
export const BOOTSTRAP_EXPOSED_CONTRACTS: readonly { contract: string; role?: string }[] = [
    { contract: 'identity.user.register' },
    { contract: 'identity.ticket.issue' },
    { contract: 'identity.whoami' },
    { contract: 'identity.user.setPassword' },
    { contract: 'serve.api.resolveByHost' },
    // resolveById's counterpart: an operator naming a *different* api by id (for a tenant other than
    // the one they're logged into) needs that api's own hostname back -- every call self-exposed on
    // it has to be sent there, not to the login host.
    { contract: 'serve.api.resolveById' },
    // Operator, not public. They were public as "routing metadata" -- but find_one took any query, so
    // `?query={"slug":{"$ne":"platform"}}` walked every organization, name, slug and owner's user id,
    // with no ticket at all (2026-09-26). A member learns their own organizations' slugs from
    // identity.whoami; nothing over HTTP needs anyone else's.
    { contract: 'identity.organization.get', role: 'operator' },
    { contract: 'identity.organization.find_one', role: 'operator' },
    // A second tenant is otherwise unreachable through the api at all -- found live, needing one
    // to prove real cross-tenant isolation for a site rather than just asserting it from the
    // schema. Operator-gated: onboarding a new organization is a platform decision, not something
    // any signed-in account does to itself.
    { contract: 'identity.organization.create', role: 'operator' },
    // Same finding: onboarding an org is meaningless without a way to put its own owner in it --
    // without this there is no api-reachable way to make a second tenant's account actually resolve
    // into that tenant at all (identity.whoami's own organizations[] comes from this collection).
    { contract: 'identity.membership.create', role: 'operator' },
    { contract: 'identity.membership.update', role: 'operator' },
    // Grants/revokes a cluster-scoped role (e.g. the `member`/`admin` a site's own gates check) --
    // distinct from org membership above, and the only api-reachable way to change one.
    { contract: 'identity.user.grantRole', role: 'operator' },
    { contract: 'serve.expose.add', role: 'operator' },
    { contract: 'serve.expose.remove', role: 'operator' },

    // ── Managing sites, over the api rather than around it ───────────────────────────────────
    //
    // `bootstrap` is the last thing that reaches into the mesh directly, because its job is to
    // create the gate; everything after it is meant to be an ordinary api client. That was only
    // half true: `src/sync.ts` brings a site up by calling 32 contracts over the mesh, 28 of which
    // nothing exposed -- so the one workflow the platform exists for had no way through its own
    // front door, and nobody noticed because the tool that did it skipped the door.
    //
    // Why `find_one` and `update` when the console already exposes the plural `find`: those serve
    // different shapes. A console *browses* -- lists rows and a human picks one. A reconciler
    // *converges* -- find-or-create-or-update by key, with nobody watching. Only `find_one` and
    // `update` serve the second, which is why they were missing rather than forgotten.
    //
    // Every one carries `role: 'operator'`. The collections' own contracts declare
    // `permissions: []` (they are reachable in-process by anything already inside the mesh), so
    // without a role on the row these would be anonymous writes. The row is the floor here, and it
    // is the whole reason an expose row can name one.
    { contract: 'serve.repo.find', role: 'operator' },
    { contract: 'serve.repo.find_one', role: 'operator' },
    { contract: 'serve.repo.create', role: 'operator' },
    { contract: 'serve.repo.update', role: 'operator' },

    { contract: 'serve.part.find', role: 'operator' },
    { contract: 'serve.part.find_one', role: 'operator' },
    { contract: 'serve.part.create', role: 'operator' },
    { contract: 'serve.part.update', role: 'operator' },
    { contract: 'serve.part.start', role: 'operator' },
    { contract: 'serve.part.stop', role: 'operator' },

    // Reads, plus the one real write: `requestBuild` -- which resolves the part, checks driver
    // kinds, defaults status, and queues the row as 'pending'. `create`/`update`/`delete` on this
    // collection stay internal (writing the row directly skips all of `requestBuild`'s validation,
    // which is exactly what sync.ts used to do -- fixed alongside this).
    //
    // `build` is not exposed, on purpose, though it once was here -- a real mistake, caught by
    // actually walking this path end to end rather than trusting the contract's own `permissions`
    // floor as sufficient. It has no `visibility: 'public'` (defaults `internal`), which is not an
    // oversight: `requestBuild` only *queues* a row; `serve.artifact.watchRelease` (a leaderScoped
    // interval already running every 60s, no operator action needed) sweeps pending artifacts and
    // hands each to `serve.queue`, whose own dispatcher is the only caller `build` is meant to
    // have. An operator watching a build's progress polls `find_one`/`get` for its `status`, the
    // same shape any submit-then-poll build api has -- there was never a "run this specific
    // already-queued job yourself" endpoint to expose.
    { contract: 'serve.artifact.find', role: 'operator' },
    { contract: 'serve.artifact.find_one', role: 'operator' },
    { contract: 'serve.artifact.get', role: 'operator' },
    { contract: 'serve.artifact.requestBuild', role: 'operator' },

    { contract: 'serve.composition.find', role: 'operator' },
    { contract: 'serve.composition.find_one', role: 'operator' },
    { contract: 'serve.composition.create', role: 'operator' },
    { contract: 'serve.composition.update', role: 'operator' },
    { contract: 'serve.composition.compose', role: 'operator' },

    { contract: 'serve.cdn.find', role: 'operator' },
    { contract: 'serve.cdn.find_one', role: 'operator' },
    { contract: 'serve.cdn.create', role: 'operator' },
    { contract: 'serve.cdn.update', role: 'operator' },
    { contract: 'serve.cdn.deploy', role: 'operator' },

    { contract: 'serve.api.find', role: 'operator' },
    { contract: 'serve.api.find_one', role: 'operator' },
    { contract: 'serve.api.create', role: 'operator' },
    { contract: 'serve.api.generateClient', role: 'operator' },

    { contract: 'serve.expose.find', role: 'operator' },
    { contract: 'serve.expose.find_one', role: 'operator' },
];

/**
 * Idempotent, and callable from two different places: `ApiService.onStart` (every ordinary boot,
 * once the "platform" organization already exists) and `mesh-serve bootstrap` (the one first-claim
 * run, which creates "platform" itself and needs this to happen in the very same call, since onStart
 * has already run once and won't run again to notice the org showing up later). No-ops rather than
 * failing if "platform" doesn't exist yet -- a node that hasn't been claimed has nothing to attach a
 * bootstrap api to.
 *
 * Looks for an *existing* api by tenant, not by hostname: `apiHost` is only ever consulted here for
 * the one-time create -- an operator can (via `bootstrap`'s own prompt) choose a hostname other than
 * the default, and every later boot's argument-less `ensureBootstrapApi(broker)` call still has to
 * find that same row again. Looking it up by `apiHost` would silently try to create a second,
 * default-hostname bootstrap api on every boot after a custom one was chosen; there is only ever
 * meant to be one per tenant, so tenant is the real identity here, not the host.
 */
export async function ensureBootstrapApi(broker: IServiceBroker, apiHost: string = BOOTSTRAP_API_HOST): Promise<void> {
    const organization = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
    if (organization === undefined) {
        return;
    }

    const meta = { tenant_id: organization.id };
    const existing = await broker.call('serve.api.find_one', { query: { tenantId: organization.id } }, { meta });
    if (existing !== undefined) {
        return;
    }

    broker.logger.info(`Creating bootstrap api "${apiHost}"...`);
    const api = await broker.call('serve.api.create', {
        tenantId: organization.id, apiHost,
    }, { meta });

    for (const { contract, role } of BOOTSTRAP_EXPOSED_CONTRACTS) {
        broker.logger.info(`Exposing "${contract}"${role ? ` (role: ${role})` : ''} on ${apiHost}...`);
        await broker.call('serve.expose.create', {
            tenantId: organization.id,
            apiId: api.id,
            contract,
            ...(role !== undefined ? { role } : {}),
        }, { meta });
    }
}
