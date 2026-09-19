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
 * Exposed on the bootstrap api the moment it's created -- how a fresh install gets anyone in at
 * all, plus the calls that let an operator start configuring more without anything pre-seeded by
 * hand. Kept minimal on purpose: register, log in, ask who you are, set a real password, and (for the
 * same "configure more" reason as expose.add/remove) resolve an api's own id/tenant from its
 * hostname. Public (no role): it's a read of non-sensitive routing data, the same standing
 * `serve.cdn.resolveHost` already has for exactly the same "for a caller who has nothing else yet"
 * reason. Anything else goes through explicit expose rows once something needs it.
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
    // Public for the same reason as resolveByHost above: constructing a valid serve.part key
    // ("<slug>/<name>") needs a tenant's slug, and an organization's name/slug is routing metadata,
    // not a secret.
    { contract: 'identity.organization.get' },
    // Looks an organization up by slug before having an id to `.get` with at all -- same public
    // reasoning as `.get` above.
    { contract: 'identity.organization.find_one' },
    { contract: 'serve.expose.add', role: 'operator' },
    { contract: 'serve.expose.remove', role: 'operator' },
];

/**
 * Idempotent, and callable from two different places: `ApiService.onStart` (every ordinary boot,
 * once the "platform" organization already exists) and `src/bootstrap.ts` (the one first-claim run,
 * which creates "platform" itself and needs this to happen in the very same call, since onStart has
 * already run once and won't run again to notice the org showing up later). No-ops rather than
 * failing if "platform" doesn't exist yet -- a node that hasn't been claimed has nothing to attach a
 * bootstrap api to.
 */
export async function ensureBootstrapApi(broker: IServiceBroker): Promise<void> {
    const organization = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
    if (organization === undefined) {
        return;
    }

    const meta = { tenant_id: organization.id };
    const existing = await broker.call('serve.api.find_one', { query: { apiHost: BOOTSTRAP_API_HOST } }, { meta });
    if (existing !== undefined) {
        return;
    }

    broker.logger.info(`Creating bootstrap api "${BOOTSTRAP_API_HOST}"...`);
    const api = await broker.call('serve.api.create', {
        tenantId: organization.id, apiHost: BOOTSTRAP_API_HOST,
    }, { meta });

    for (const { contract, role } of BOOTSTRAP_EXPOSED_CONTRACTS) {
        broker.logger.info(`Exposing "${contract}"${role ? ` (role: ${role})` : ''} on ${BOOTSTRAP_API_HOST}...`);
        await broker.call('serve.expose.create', {
            tenantId: organization.id,
            apiId: api.id,
            contract,
            ...(role !== undefined ? { role } : {}),
        }, { meta });
    }
}
