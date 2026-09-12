/**
 * Bringing a cluster up from nothing.
 *
 * **A cluster with no sites cannot be reached.** Resolution is connection → site, so on a fresh node
 * there is no route to `identity.ticket_issue`, so nobody can sign in, so no site can be created.
 * Something has to break that circle from inside the process.
 *
 * ## This file is question D1, and it is deliberately not a domain
 *
 * The previous answer was `cdn/methods/control.ts`: **414 lines reaching into 33 foreign contracts**
 * across identity, catalog, builder, fleet and telemetry. That single file is why the CDN appeared
 * to depend on everything — it was not the CDN having dependencies, it was orchestration filed under
 * a domain name because it needed somewhere to live.
 *
 * So it lives here, at the top level, named for what it is. It is allowed to call several domains
 * because orchestration is its whole job, and putting it anywhere else disguises that as a
 * dependency of something. Where it *belongs* is `spec/questions.md` **D1** and is still open; what
 * is settled is that it must not be hidden inside a domain again.
 *
 * ## Idempotent, and running it twice is how you find out
 *
 * Every step checks before it writes. A node restarts, and a node that died halfway through its
 * first boot has to be able to try again.
 */

import type { IServiceBroker } from '@flybyme/mesh';

import { FIRST_BOOT_EMAIL } from './identity/identity.service.js';
import type { ExposedContract } from './serve/schema/site.js';

export interface BootstrapOptions {
    /** The hostname the control site answers on. */
    readonly host?: string;
    /** The first organization's slug. */
    readonly slug?: string;
    readonly name?: string;
    readonly announce?: (line: string) => void;
}

export interface BootstrapResult {
    readonly organizationId: string;
    readonly siteId: string;
    readonly host: string;
    /** What this run actually did, so a restart can say "nothing" rather than imply it worked. */
    readonly created: readonly string[];
}

/**
 * What the control site answers.
 *
 * **Written out rather than computed from "everything mounted".** A site exposes a subset and the
 * subset is the security model — a control site built from the node's whole registry would serve
 * every internal contract the day somebody mounted one, which is precisely the property
 * `spec/serving.md` §9 exists to keep.
 *
 * `user` is the coarse level meaning *some caller*, and it is what most of these want: the gate
 * establishes there is an account, and the collection's own scope does the rest.
 */
export const CONTROL_CONTRACTS: readonly ExposedContract[] = [
    // Signing in, out, and finding out who you are. Public because each is a call that cannot
    // require having already made it.
    { key: 'identity.ticket_issue', auth: 'public', errors: [] },
    { key: 'identity.sign_out', auth: 'public', errors: [] },
    { key: 'identity.set_password', auth: 'user', errors: [] },
    { key: 'identity.whoami', auth: 'user', errors: [] },

    // The reads a terminal needs. `mesh-serve organization find`, and the rest of cli.md §1.
    { key: 'organization.find', auth: 'user', errors: [] },
    { key: 'organization.get', auth: 'user', errors: [] },
    { key: 'organization.count', auth: 'user', errors: [] },
    { key: 'organization.create', auth: 'user', errors: [] },

    { key: 'membership.find', auth: 'user', errors: [] },
    { key: 'membership.get', auth: 'user', errors: [] },

    { key: 'site.find', auth: 'user', errors: [] },
    { key: 'site.get', auth: 'user', errors: [] },
    { key: 'site.count', auth: 'user', errors: [] },
    { key: 'site.create', auth: 'user', errors: [] },
];

/**
 * Create what a fresh cluster is missing, and nothing it already has.
 *
 * Run after every module has registered, because it calls into several of them. The account itself
 * is identity's own first boot — a cluster with no accounts is identity's problem, and this one is
 * about there being somewhere to *reach* that account.
 */
export async function bootstrap(
    broker: IServiceBroker,
    options: BootstrapOptions = {},
): Promise<BootstrapResult> {
    const host = options.host ?? '127.0.0.1';
    const slug = options.slug ?? 'platform';
    const announce = options.announce ?? (() => {});
    const created: string[] = [];

    /**
     * The account this all belongs to.
     *
     * **Found by email rather than by "the first row".** `user.find` with no query has no defined
     * order, so *the first account* is whatever the database felt like returning — and on the second
     * boot that is a different account from the one on the first.
     */
    const accounts = await broker.call('user.find', { query: { email: FIRST_BOOT_EMAIL }, limit: 1 });
    const owner = accounts[0];
    if (owner === undefined) {
        throw new Error(
            `Bootstrap found no account for ${FIRST_BOOT_EMAIL}. Identity creates it at first boot, `
            + `so this means identity did not start, or started after this ran.`,
        );
    }

    // 1. The organization.
    const organizations = await broker.call('organization.find', { query: { slug }, limit: 1 });
    let organization = organizations[0];
    if (organization === undefined) {
        organization = await broker.call('organization.create', {
            slug,
            name: options.name ?? 'Platform',
            ownerId: owner.id,
        });
        created.push(`organization ${slug}`);
    }

    /**
     * 2. The membership.
     *
     * Owning an organization and being a member of it are different facts, and the scope comes from
     * the membership. An owner with no membership resolves to no scope and is refused by every
     * scoped read on the thing they own — which reads as a permissions bug and is a missing row.
     */
    /**
     * **Bootstrap acts as the owner, and says so.**
     *
     * `membership.find` is narrowed to the calling account by a hook, so a call with no meta reads
     * nothing and this would create a second membership on every boot. Passing the owner is not a
     * workaround for the narrowing — it is the true statement: these rows are being created *for*
     * that account, and an audit that said otherwise would be wrong.
     */
    const asOwner = { meta: { user: { id: owner.id, tenant_id: organization.id } } };

    const memberships = await broker.call('membership.find', {
        query: { userId: owner.id, organizationId: organization.id },
        limit: 1,
    }, asOwner);

    if (memberships[0] === undefined) {
        await broker.call('membership.create', {
            userId: owner.id,
            organizationId: organization.id,
            roleKey: 'operator',
            joinedAt: Date.now(),
        }, asOwner);
        created.push(`membership ${owner.email} in ${slug}`);
    }

    // 3. The control site.
    const sites = await broker.call('site.find', { query: { host }, limit: 1 });
    let site = sites[0];
    if (site === undefined) {
        site = await broker.call('site.create', {
            host,
            organizationId: organization.id,
            title: 'Control',
            description: 'The site a node serves for itself, so a fresh cluster can be reached.',
            contracts: [...CONTROL_CONTRACTS],
        });
        created.push(`site ${host} — ${String(CONTROL_CONTRACTS.length)} contracts`);
    }

    for (const line of created) announce(`bootstrap: ${line}`);

    return { organizationId: organization.id, siteId: site.id, host, created };
}
