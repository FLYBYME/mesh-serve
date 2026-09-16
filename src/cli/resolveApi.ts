import { hostnameOf } from './client.js';
import type { buildClient } from './client.js';

/**
 * `serve.api.apiHost` is always bare (`flow-api.localhost`, no port) -- real DNS/a reverse proxy
 * resolves it in production, but this session's own local, unproxied node serves *every* api on one
 * port via the Host header alone. So the port worth keeping is whichever one already got this session
 * to a real server (`session.apiHost`'s own, if it has one) applied to the *target* api's hostname,
 * not the bare hostname alone -- which would silently try port 80/443 and fail to connect. Exported
 * for callers that resolve a target api's host some other way (`init`'s own `--config` path, which
 * creates an api rather than looking one up by id).
 */
export function withSamePort(sessionApiHost: string, targetHost: string): string {
    const port = sessionApiHost.split(':')[1];
    return port === undefined ? targetHost : `${targetHost}:${port}`;
}

/**
 * What every command that names `--api`/`--tenant` actually needs, resolved from the session's own
 * current host rather than required as flags a caller has to already know from somewhere -- before
 * `serve.api.resolveByHost`/`resolveById` became bootstrap-exposed, the only way to get an api's own
 * id, tenant, or hostname was a raw Mongo query, for the api you were already logged into.
 * `--api`/`--tenant` stay as explicit overrides (an operator naming a *different* tenant to create
 * in, per `serve.api.create`'s own cross-tenant support) rather than going away entirely.
 *
 * `apiHost` is the point of this returning more than the two ids `init`/`publish` originally asked
 * for: a caller (`buildClient`) needs to send every subsequent call to *that* api's real hostname, not
 * to the session's own -- a self-heal step that exposes a contract on a *different* api and then a
 * caller that keeps talking to its own host 404s on every single one of them, having just exposed
 * them somewhere else entirely. Found live creating a second tenant's own api for the first time; every
 * earlier run happened to target the api already logged into, which hid this completely.
 */

export async function resolveApi(
    loginClient: ReturnType<typeof buildClient>,
    session: { readonly apiHost: string },
    overrides: { readonly api?: string; readonly tenant?: string },
): Promise<{ readonly apiId: string; readonly tenantId: string; readonly apiHost: string }> {
    if (overrides.api === undefined) {
        const api = await loginClient.call('serve.api.resolveByHost', { apiHost: hostnameOf(session.apiHost) });
        return { apiId: api.id, tenantId: overrides.tenant ?? api.tenantId, apiHost: session.apiHost };
    }
    const api = await loginClient.call('serve.api.resolveById', { id: overrides.api });
    return { apiId: overrides.api, tenantId: overrides.tenant ?? api.tenantId, apiHost: withSamePort(session.apiHost, api.apiHost) };
}
