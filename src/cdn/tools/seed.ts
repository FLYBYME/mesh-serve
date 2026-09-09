/**
 * `site.seed` — import, release, compose, grant, deploy. One authenticated call.
 *
 * The pipeline this replaces is `src/bring-up.ts`, which joined the mesh as a peer and asserted its
 * own operator identity (roadmap D6). Here every step is a contract call made *as the caller*, whose
 * standing the gate already checked.
 *
 * **Idempotent, and running it twice is how you find out that it is.** Imports declare or update,
 * releases are cached when the commit has not moved, composing the same parts is the same release,
 * and deploying a release a site already serves changes nothing.
 */

import { ClientError, type IServiceContext, type z } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import type { seedContract } from '../contracts/seed.contract.js';
import { grantsFor } from '../methods/grants.js';

type Input = z.infer<typeof seedContract['inputSchema']>;
type Output = z.infer<typeof seedContract['outputSchema']>;

/**
 * How long a call that clones and bundles may take.
 *
 * The broker's default is ten seconds, which is right for a question and wrong for work: releasing
 * mesh-core is seven clones and seven bundles, and took 22 seconds on a warm machine. The failure
 * that produced this number is worth naming — the caller timed out at ten seconds and reported
 * `RPC Timeout`, while the builder carried on and finished every part correctly. The run *failed*
 * and the work *succeeded*, which is the most confusing pair of outcomes available.
 */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** `0.16.1` → `^0.16`, so a release rolls forward within its own line and no further. */
const rangeFor = (version: string): string => {
    const [major, minor] = version.split('.');
    return major === undefined || minor === undefined ? `^${version}` : `^${major}.${minor}`;
};

type Call = (tool: string, params: unknown, options?: unknown) => Promise<unknown>;

export async function site_seed(
    this: CdnService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const meta = (ctx.meta ?? {}) as {
        user?: { id?: string; tenant_id?: string; roles?: readonly string[] };
        tenant_id?: string;
    };
    const userId = meta.user?.id;
    if (userId === undefined || userId === '') {
        throw new ClientError(
            'Seeding a site records who owns it, so it requires an authenticated caller.',
            'caller_unknown', 401,
        );
    }

    const call = ((ctx.broker as unknown as { call: Call }).call.bind(ctx.broker)) as Call;
    const problems: string[] = [];

    /**
     * **Whose site this is.**
     *
     * The caller's organization, created here when they named one that does not exist yet — which is
     * how the first tenant on a cluster comes into being, since the first operator belongs to
     * nothing. Their membership is `owner`, so the person who seeded a site is its admin as a
     * consequence of having seeded it.
     *
     * `owner` is organization-scoped and `operator` is cluster-scoped, and the two are enforced
     * apart (`identity/schema/roles.ts`, roadmap F3): an operator is not automatically an owner of
     * anything, which is the distinction that answered `403 card.create requires the operator role`
     * on the first day somebody tried.
     */
    const organizationId = await ensureOrganization(call, input, userId, meta.user?.tenant_id ?? meta.tenant_id);
    /**
     * Every call below runs in the caller's organization.
     *
     * Both spellings of the scope, because a collection is narrowed by *its own* field name —
     * `site` declares `tenantId` and `membership` declares `organizationId`, and a meta carrying
     * only one of them is refused by the other. `bring-up.ts`'s `callerFor` set both for exactly
     * this reason.
     */
    const as = {
        meta: {
            ...meta,
            organizationId,
            tenantId: organizationId,
            tenant_id: organizationId,
            user: { ...meta.user, id: userId, tenant_id: organizationId },
        },
    };

    // ------------------------------------------------------------------ import and release

    /** part name → the version just released, and what kind of part it is. */
    const versions = new Map<string, string>();
    const kinds = new Map<string, string>();

    for (const source of input.sources) {
        const imported = await call('builder.import_repo', {
            repository: source.repository,
            ref: source.ref,
            ...(source.subdirectory === undefined ? {} : { subdirectory: source.subdirectory }),
        }, { ...as, timeout: BUILD_TIMEOUT_MS }) as {
            parts: readonly { name: string; kind: string; version?: string }[];
        };

        for (const part of imported.parts) kinds.set(part.name, part.kind);

        if (input.importOnly) continue;

        /**
         * **The kernel's label is pinned to what it declares; every other part's is minted.**
         *
         * Minted labels and declared ranges can come apart, and for the kernel that is fatal. Every
         * part declares `kernel: ^0.16`, meaning the kernel's *real* version — while the catalog
         * mints from its own sequence, which on a cluster that has released before had reached
         * `0.16.0`, so the same commit published as `0.16.1`: correct by the catalog's rules and
         * unsatisfiable by every part naming it.
         *
         * A part nobody depends on can carry any label. The kernel cannot. `import_repo` reports the
         * declared version for a kernel and for nothing else, which is exactly this need — and
         * relabelling is lossless, since `(partName, commit)` is the identity.
         *
         * Skipping this is not subtle in its failure: the first seed through this contract composed
         * a kernel labelled `0.1.0` and refused itself with *"auth requires kernel ^0.16, but this
         * release serves 0.1.0"*.
         */
        for (const part of imported.parts) {
            if (part.kind !== 'kernel' || part.version === undefined) continue;
            await call('builder.release_part', {
                part: part.name,
                version: part.version,
                bump: 'patch',
                branch: source.ref,
            }, { ...as, timeout: BUILD_TIMEOUT_MS });
            versions.set(part.name, part.version);
        }

        const released = await call('builder.release_repo', {
            repository: source.repository,
            bump: 'patch',
            branch: source.ref,
        }, { ...as, timeout: BUILD_TIMEOUT_MS }) as {
            released: readonly { part: string; version: string }[];
            failed: readonly { part: string; reason: string }[];
        };

        for (const part of released.released) versions.set(part.part, part.version);
        for (const failure of released.failed) {
            problems.push(`${failure.part} did not build: ${failure.reason}`);
        }
    }

    const parts = [...versions].map(([name, version]) => ({
        name, version, kind: kinds.get(name) ?? 'application',
    }));

    if (input.importOnly) {
        return {
            host: input.host,
            siteId: '',
            organizationId,
            parts: [...kinds].map(([name, kind]) => ({ name, version: '', kind })),
            problems,
        };
    }

    /**
     * **A part that failed to build stops this before composing.**
     *
     * Composing on a partial release produces a second, more confusing failure — *published but has
     * no artifact* — several steps away from the build that actually failed, and pointing at a
     * command that would not fix it.
     */
    if (problems.length > 0) {
        throw new ClientError(
            `${String(problems.length)} part(s) failed to build, so nothing was composed:\n${problems.join('\n')}`,
            'build_failed', 422,
        );
    }

    // ------------------------------------------------------------------ compose

    const kernelName = [...kinds].find(([, kind]) => kind === 'kernel')?.[0];
    const kernelVersion = kernelName === undefined ? undefined : versions.get(kernelName);
    if (kernelVersion === undefined) {
        throw new ClientError(
            'No kernel was released, so there is nothing to compose against. The kernel repository '
            + 'is the first one imported; check what it declared.',
            'no_kernel', 422,
        );
    }

    const composing = parts
        .filter((part) => part.name !== kernelName)
        .filter((part) => input.parts === undefined || input.parts.includes(part.name))
        .map((part) => ({
            kind: part.kind === 'application' ? 'application' as const : 'extension' as const,
            id: part.name,
            version: rangeFor(part.version),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));

    /**
     * The site is named after what it serves.
     *
     * `application` and `title` were both hardcoded `console`, so a site holding one application
     * called flowboard served a page whose `<title>` said Console — which is what a person sees in a
     * tab, and it was wrong for every site but this platform's own.
     *
     * **The single *application* names it, not the single part.** The CLI's rule was "one `--parts`
     * names the site", which is a different question: `--parts flowboard,auth,flowboard-agent` is
     * one application plus an extension plus an agent surface, and it still fell back to `console`.
     * A release has one thing a person opens; extensions and agent parts are not it.
     */
    const applications = composing.filter((part) => part.kind === 'application');
    const application = input.application
        ?? (applications.length === 1 ? applications[0]?.id : undefined)
        ?? 'console';

    const composed = await call('cdn.compose', {
        kernel: input.kernelRange ?? rangeFor(kernelVersion),
        parts: composing,
        name: input.releaseName ?? application,
        rolling: true,
    }, as) as {
        hash: string;
        problems: readonly { message: string }[];
    };

    if (composed.hash === '') {
        throw new ClientError(
            `The composition did not hold together:\n${composed.problems.map((p) => p.message).join('\n')}`,
            'compose_failed', 422,
        );
    }

    /**
     * **`requires` and the role map come from the release row, not from what compose returned.**
     *
     * `cdn.compose` answers with the hash, the pinned parts and any problems — the union of what the
     * parts call is written *onto the row*, which is where a site's grants are derived from. Reading
     * it off the compose output instead is `TypeError: requires is not iterable`, which is a truthful
     * error about a field that was never there.
     */
    const release = await call('release.find_one', { query: { hash: composed.hash } }, as) as {
        requires?: readonly string[];
        agentRoles?: Readonly<Record<string, readonly string[]>>;
    } | null | undefined;

    // ------------------------------------------------------------------ the site, and its grants

    /**
     * **Grants are derived from what the release calls, and rewritten every run.**
     *
     * `cdn.deploy` refuses a release calling a contract the site does not expose — correctly, since
     * the alternative is a 404 at run time found by whoever opens the page. A hand-maintained list
     * goes stale exactly when a part is added, which is the moment somebody is least able to guess
     * why the deploy was refused.
     */
    const { contracts, events } = grantsFor(release?.requires ?? [], release?.agentRoles);
    const mesh = [{ package: '@flybyme/mesh-serve', version: '^0.1.0', contracts, events }];
    const api = input.api ?? this.controlApi() ?? '';

    const existing = await call('site.find_one', { query: { host: input.host } }, as) as
        { id: string; tenantId?: string } | null | undefined;

    let siteId: string;
    if (existing?.id !== undefined) {
        /**
         * Seeding somebody else's hostname is refused rather than taken over.
         *
         * A hostname is one origin on the internet, so a second claim on it is a tenant takeover —
         * the same reasoning that makes `site.host` globally unique rather than unique per tenant.
         */
        if (existing.tenantId !== undefined && existing.tenantId !== organizationId) {
            throw new ClientError(
                `"${input.host}" already belongs to another organization.`,
                'host_taken', 409,
            );
        }
        await call('site.update', { id: existing.id, mesh, api }, as);
        siteId = existing.id;
    } else {
        const created = await call('site.create', {
            host: input.host,
            application,
            tenantId: organizationId,
            api,
            mesh,
            theme: {},
            policy: {},
            title: input.title ?? application.charAt(0).toUpperCase() + application.slice(1),
        }, as) as { id: string };
        siteId = created.id;
    }

    await call('cdn.deploy', { host: input.host, release: composed.hash }, as);

    ctx.logger.info(
        `[cdn] seeded ${input.host} → ${composed.hash} (${String(composing.length)} part(s), by ${userId})`,
    );

    return { host: input.host, siteId, organizationId, release: composed.hash, parts, problems };
}

/**
 * The organization that owns the site, and the caller's ownership of it.
 *
 * Three cases, in order: one named in the input (created if new), the caller's own resolved scope,
 * or nothing — and nothing is refused rather than guessed. An operator who belongs to two
 * organizations and names neither is asking this call to pick a tenant for a hostname, which is not
 * a decision a default should make.
 */
async function ensureOrganization(
    call: Call,
    input: Input,
    userId: string,
    scope: string | undefined,
): Promise<string> {
    if (input.organization === undefined) {
        if (scope !== undefined && scope !== '') return scope;
        throw new ClientError(
            'A site belongs to an organization and this caller resolved none. Name one — it is '
            + 'created if it does not exist, and you become its owner.',
            'organization_unknown', 400,
        );
    }

    const found = await call('organization.find_one', {
        query: { slug: input.organization.slug },
    }) as { id: string } | null | undefined;

    if (found?.id !== undefined) return found.id;

    /**
     * **Creating an organization makes the caller its owner, and identity does that itself.**
     *
     * `identity`'s `beforeCrud` overwrites `ownerId` with the caller — *"a caller who may create an
     * organization must not be able to create one owned by somebody else"* — and its `afterCrud`
     * calls `reownOrganization`, which writes the `owner` membership. So seeding a site and being
     * able to administer it are the same act, without this file arranging it.
     *
     * Creating the membership here as well was not merely redundant, it failed: the compound key
     * `(organizationId, userId)` is unique, so the second write is a `CONFLICT` on a fresh cluster.
     * `ownerId` is still sent because `OrganizationSchema` requires it — an organization with no
     * owner must be unconstructible (surfdns#29) — and the value is replaced with the caller's.
     */
    const created = await call('organization.create', {
        slug: input.organization.slug,
        name: input.organization.name,
        ownerId: userId,
    }) as { id: string };

    return created.id;
}
