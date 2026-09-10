/**
 * **The site a node serves for itself.**
 *
 * A cluster with no sites cannot be reached. The api dispatches by `Host` → site, so on a fresh node
 * `identity.ticket_issue` is running, mounted, and pointed at by nothing — there is no route to it,
 * so there is no way to sign in, so there is no way to create the first site. The way out, until now,
 * was to go around the api entirely: `src/bring-up.ts` joins the mesh as a peer and calls contracts
 * directly, and `npx mesh … --bootstrap ws://…` does the same by hand.
 *
 * Both are the same hole. **Roadmap D6**: any peer that completes the mesh handshake may construct
 * any meta it likes, so `requireOperator` reads what the caller said about itself and `scopedBy`
 * narrows by a tenant the caller asserted. `MESH_KEY` is not one boundary among several — it is the
 * only one. D6's real fix is a broker-level check, and it is marked ⛔ mesh; `mesh/docs/STABILITY.md`
 * froze mesh, so **closing the door is the mitigation**.
 *
 * So the node ensures one site for itself, and every operator action becomes an ordinary
 * authenticated HTTP call through the same gate as everything else. `roadmap F6` did exactly this to
 * `publish-cli` on 2026-09-06; `bring-up` is the last one left.
 *
 * ## Why this is a site and not a special endpoint
 *
 * Because then it is not special. `mesh-serve` is already descriptor-driven — it reads `/_describe`
 * and dispatches — so a control *site* means `login`, seeding and token issuing are ordinary calls
 * needing no new machinery, no second dispatch path, and no second thing to gate. A `/_control`
 * endpoint beside the site model would be a parallel surface that has to be kept in step with the
 * real one, which is roadmap D11's lesson about the api and MCP paths, arriving early.
 *
 * It is also where `mesh-operator` is composed once it is ported, so *everything is exposed through
 * the ui* and *everything is exposed through the cli* are the same sentence about the same surface.
 */

import type { IServiceBroker } from '@flybyme/mesh';

import type { ExposedContract } from '../schema/site.js';

/**
 * Where a node answers before it has a hostname.
 *
 * `127.0.0.1` because it is true before DNS, before a certificate and before anybody has decided
 * what this deployment is called — and because the first thing an operator does is bring a cluster
 * up from a terminal on the machine itself.
 */
export const DEFAULT_CONTROL_HOST = '127.0.0.1';

/** The organization the control site belongs to. Not a tenant — the platform's own row. */
export const PLATFORM_SLUG = 'platform';

/**
 * What an operator may reach on it.
 *
 * **Every key here is already `visibility: 'public'`** — which means *may be exposed*, never
 * *unauthenticated*; the gate below is what decides who. `describeExposure` throws on an internal
 * contract rather than quietly skipping it, and a throw here would take the whole site's descriptor
 * down with a 500 — which is exactly what granting `identity.ticket_revoke` did on 2026-09-08. So
 * this list is checked against `visibility` by a test rather than by hope.
 *
 * The gates are deliberate rather than uniform:
 *
 * - `ticket_issue` and `set_password` are **public**, because signing in and claiming a provisional
 *   account are what somebody with no session does. `set_password` takes no `userId` — the caller
 *   *is* the subject — which is what makes public safe.
 * - `register` is **absent**. On a tenant site it is how people join; on the platform's own control
 *   surface it would be a way to mint accounts on a machine you have not signed in to.
 * - everything else is **operator**, because it changes what the platform runs.
 */
export const CONTROL_CONTRACTS: readonly ExposedContract[] = [
    // Signing in, and the one thing a provisional account may do.
    { key: 'identity.ticket_issue', auth: 'public' },
    { key: 'identity.set_password', auth: 'public' },
    { key: 'identity.whoami', auth: 'user' },
    { key: 'identity.sign_out', auth: 'user' },

    // Who may do what.
    { key: 'identity.grant_role', auth: 'operator' },
    /**
     * **Nothing here lists the cluster's accounts, and that is the design.**
     *
     * `user.find` cannot be exposed — `passwordHash` is a field of `UserSchema`, a generated find
     * returns it, and no gate subtracts a field (freeze gate V2). `identity.people` was a projection
     * written to get around that and was withdrawn on 2026-09-10 (V8): the operator brings a cluster
     * up and hands it over, so reading every account on the deployment is not part of the role.
     *
     * *Who is in this organization* is `membership.find` below, scoped by `organizationId`.
     */
    { key: 'organization.find', auth: 'operator' },
    { key: 'organization.get', auth: 'operator' },
    { key: 'organization.create', auth: 'operator' },
    { key: 'membership.find', auth: 'operator' },
    { key: 'membership.create', auth: 'operator' },
    { key: 'membership.delete', auth: 'operator' },
    { key: 'role.find', auth: 'operator' },

    // What the platform knows how to build.
    { key: 'catalog.declare', auth: 'operator' },
    { key: 'catalog.resolve', auth: 'operator' },
    { key: 'part.find', auth: 'operator' },
    { key: 'part.get', auth: 'operator' },
    { key: 'partVersion.find', auth: 'operator' },
    { key: 'partVersion.get', auth: 'operator' },

    // Building it.
    { key: 'builder.import_repo', auth: 'operator' },
    { key: 'builder.release_part', auth: 'operator' },
    { key: 'builder.release_repo', auth: 'operator' },
    { key: 'builder.get_artifact', auth: 'operator' },

    // Composing and serving it.
    { key: 'cdn.compose', auth: 'operator' },
    { key: 'cdn.deploy', auth: 'operator' },
    { key: 'cdn.site_edit', auth: 'operator' },
    { key: 'release.find', auth: 'operator' },
    { key: 'release.get', auth: 'operator' },
    /**
     * **This organization's sites, not the deployment's.** `site` is `scopedBy: 'tenantId'`, so an
     * operator asking here gets the sites of whichever organization their scope resolves to, which
     * on a control site is the platform's own.
     *
     * That distinction is the one a console got wrong on 2026-09-10, rendering exactly this read
     * under a header saying *What this cluster serves*. It looked right because the only clusters
     * anyone had tested on had one organization. The answer is that the screen says what it shows,
     * not that the read widens — see `site.contract.ts` for the two doors, and freeze gate V15 for
     * the two-organization fixture that would have caught it.
     */
    { key: 'site.find', auth: 'operator' },
    { key: 'site.get', auth: 'operator' },
    { key: 'site.create', auth: 'operator' },
    /**
     * The whole pipeline in one call, so a browser and a CLI seed a site the same way rather than
     * the CLI owning an orchestration a console would have to reimplement.
     */
    { key: 'site.seed', auth: 'operator' },

    // The machines.
    { key: 'node.status', auth: 'operator' },
    { key: 'node.assign', auth: 'operator' },
    { key: 'node.provision', auth: 'operator' },
];

/**
 * One narrow structural retype, not `any`.
 *
 * `broker.call<K extends keyof IServiceToolRegistry>` cannot accept a name chosen at run time.
 * `ApiService`, `McpService` and `ApprovalService` all have this shape and all solve it this way.
 */
type Call = (tool: string, params: unknown, options?: unknown) => Promise<unknown>;
const callable = (broker: IServiceBroker): Call =>
    (broker as unknown as { call: Call }).call.bind(broker);

/**
 * Long enough for identity to register on the same node, short enough that a cdn dedicated to
 * serving is not held up by a wait for something that is never coming.
 */
const DEFAULT_WAIT_MS = 5_000;

/**
 * Is this tool answerable yet?
 *
 * `waitForTool` when the registry offers it — a node that has just mounted identity is a few
 * milliseconds away, not five seconds — and a single registry look otherwise. Never `broker.call`,
 * which cannot tell *absent* from *slow* and answers both after ten seconds.
 */
async function reachable(broker: IServiceBroker, waitMs: number, stopped: () => boolean): Promise<boolean> {
    /**
     * **Ask the question you actually mean: can this call be answered?**
     *
     * Three attempts at proxying it failed, each silently, and the reasons are worth keeping because
     * they are the same reason:
     *
     * - `Registry.waitForTool` exists, but `ServiceBroker` carries both a `registry` field and
     *   `getProvider('registry')`, they are not the same shape, and `IServiceRegistry` does not
     *   declare the method. The lookup came back without it and the wait was skipped.
     * - `getCandidateNodes` reads the **peer** registry. On a single node the tool is *local* —
     *   `broker.localTools`, which no registry lists — so it answers zero for a tool that is right
     *   there and callable.
     *
     * Every one of those is a proxy for *is this callable*, and each is wrong in a different
     * direction. So call it, bounded. `ICallOptions.timeout` is what makes this affordable: the
     * default is ten seconds and the whole problem was that `broker.call` cannot tell *absent* from
     * *slow*, so the fix is to stop waiting ten seconds to find out.
     *
     * A find that answers `null` is a fine answer — it means identity is there and the organization
     * is not, which is exactly the state a first boot is in.
     */
    const call = callable(broker);
    const deadline = Date.now() + waitMs;

    for (;;) {
        if (stopped()) return false;

        /**
         * **Wait for the operator account, not merely for identity's tools.**
         *
         * Waiting on `organization.find_one` answered as soon as identity *registered*, which is
         * several steps before it has done its work: `ensureFirstOperator` runs at the end of the
         * same `onStart`, so the first probe succeeded and the very next call found no operator and
         * refused to make an organization nobody could own. A narrower version of the same race that
         * made this wait necessary in the first place.
         *
         * The account is the actual precondition — the platform organization needs an owner — so it
         * is what gets waited for.
         */
        const owner = await call('user.find_one', { query: { roles: 'operator' } }, { timeout: 1_000 })
            .then((row) => row as { id?: string } | null, () => null);

        if (owner?.id !== undefined) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resume) => setTimeout(resume, 200));
    }
}

/**
 * Ensure the control site, idempotently.
 *
 * Runs on every cdn boot, like `ensureFirstOperator` and the builtin roles. Idempotent because the
 * alternative is a node that behaves differently on its second start than its first, which is the
 * property that makes bring-up runnable twice — *and running it twice is how you find out that it
 * is.*
 *
 * **The grants are rewritten every run** and everything else about the row is left alone. A contract
 * added to `CONTROL_CONTRACTS` must not need somebody to remember to re-seed, and an operator who
 * has edited the site's title should keep it.
 */
export async function ensureControlSite(
    broker: IServiceBroker,
    options: {
        readonly host: string;
        readonly api: string;
        readonly waitMs?: number;
        /** Asked between attempts, so a stopping service stops looking. */
        readonly stopped?: () => boolean;
    },
): Promise<{
    readonly siteId: string; readonly organizationId: string;
    readonly created: boolean; readonly host: string;
} | undefined> {
    /**
     * **Wait for identity, briefly, and give up quietly.**
     *
     * Two things make this necessary and they pull in opposite directions.
     *
     * The cdn starts **before** identity on this node — `bin/node.mjs` registers the switchable
     * services first — so a single check finds nothing and skips a control site the cluster needs.
     * Asking blindly is worse: `broker.call` on a tool nobody provides does not fail, it waits out
     * the 10-second RPC timeout, so a blind call adds ten seconds to the boot of every cdn with no
     * identity beside it. That is most of the integration suite, and it turned four passing files
     * into four timeouts.
     *
     * So: wait a few seconds for identity to arrive, and if it does not, there is nothing for a
     * control site to route to and no reason to make one. That is an ordinary state on a node
     * dedicated to serving.
     */
    const waiting = await reachable(
        broker,
        options.waitMs ?? DEFAULT_WAIT_MS,
        options.stopped ?? (() => false),
    );
    if (!waiting) return undefined;

    const call = callable(broker);

    /**
     * The platform's own organization.
     *
     * A site's `tenantId` is required and *is* an organizationId, so the control site needs one. It
     * is not a tenant: nothing is billed to it and nobody is invited into it. It exists because a
     * hostname has to belong to somebody, and the platform belongs to itself.
     *
     * **No membership is created here.** An operator holds a *cluster*-scoped role, which grants
     * everywhere and lives on the user rather than in a membership (`identity/schema/roles.ts`, F3).
     * Membership matters only for `scopedBy` collections, and a caller who needs one will be told so
     * by the gate rather than quietly given it at boot.
     */
    const found = await call('organization.find_one', { query: { slug: PLATFORM_SLUG } }) as
        { id: string } | null | undefined;

    let organizationId = found?.id;
    if (organizationId === undefined) {
        /**
         * **An organization must name who can re-own it** (`OrganizationSchema.ownerId`, roadmap
         * F8b): recorded as a field rather than inferred from memberships, so the answer survives
         * the case that broke — the last owner leaving.
         *
         * For the platform's own row that is the operator identity made at first boot. Looked up
         * rather than assumed, and if there is somehow no operator this stops rather than inventing
         * one: a platform organization owned by nobody is exactly the state F8b exists to prevent.
         */
        const owner = await call('user.find_one', { query: { roles: 'operator' } }) as
            { id: string } | null | undefined;

        if (owner?.id === undefined) {
            throw new Error(
                'no account holds the operator role, so the platform organization would have no '
                + 'owner. identity creates one at first boot — this node found none.',
            );
        }

        organizationId = (await call('organization.create', {
            slug: PLATFORM_SLUG,
            name: 'Platform',
            ownerId: owner.id,
        }) as { id: string }).id;
    }

    const mesh = [{
        package: '@flybyme/mesh-serve',
        version: '^0.1.0',
        contracts: [...CONTROL_CONTRACTS],
        /**
         * No events.
         *
         * A control site streams nothing yet. `eventTable` refuses an event whose definition
         * declares no `scopedBy` — *an event that cannot be scoped is delivered to nobody* — and
         * every collection here is either global or scoped to a tenant this site is not.
         */
        events: [],
    }];

    /**
     * **The scope, supplied — and this is the one place that is defensible.**
     *
     * `site` is `scopedBy: 'tenantId'`, so a call with no scope is refused: *Scoped collection
     * "site" requires a resolved "tenantId" scope*. Everywhere else in this plan, a caller supplying
     * its own scope is the hole being closed (roadmap D6, F6) — a peer that joins the mesh can
     * assert any tenant it likes, and `bring-up` doing exactly that is what all of this is removing.
     *
     * The difference is not politeness, it is position. This is **the cdn writing its own collection
     * during its own boot**, in-process, on a row it is about to serve. There is no caller to
     * authenticate and no request to attribute; the tenant is not a claim about who is asking, it is
     * the organization this service just created two statements ago. D6's own proposed fix draws the
     * same line: *a call from a module mounted in the same process may reach anything.*
     *
     * No user is invented. Only the scope is set, so nothing here can be mistaken for somebody
     * acting.
     */
    const inPlatformScope = { meta: { tenant_id: organizationId } };

    const existing = await call('site.find_one', { query: { host: options.host } }, inPlatformScope) as
        { id: string } | null | undefined;

    if (existing?.id !== undefined) {
        await call('site.update', { id: existing.id, mesh, api: options.api }, inPlatformScope);
        return { siteId: existing.id, organizationId, created: false, host: options.host };
    }

    const created = await call('site.create', {
        host: options.host,
        application: 'control',
        tenantId: organizationId,
        api: options.api,
        mesh,
        theme: {},
        policy: {},
        title: 'Control',
    }, inPlatformScope) as { id: string };

    return { siteId: created.id, organizationId, created: true, host: options.host };
}
