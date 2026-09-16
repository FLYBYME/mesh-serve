import { hostnameOf } from './client.js';
import type { buildClient } from './client.js';

/**
 * What every command that names `--api`/`--tenant` actually needs, resolved from the session's own
 * current host rather than required as flags a caller has to already know from somewhere -- before
 * `serve.api.resolveByHost` became bootstrap-exposed, the only way to get an api's own id or tenant
 * was a raw Mongo query, for the api you were already logged into. `--api`/`--tenant` stay as
 * explicit overrides (an operator naming a *different* tenant to create in, per `serve.api.
 * create`/create's own cross-tenant support) rather than going away entirely.
 */
export async function resolveApi(
    client: ReturnType<typeof buildClient>,
    session: { readonly apiHost: string },
    overrides: { readonly api?: string; readonly tenant?: string },
): Promise<{ readonly apiId: string; readonly tenantId: string }> {
    if (overrides.api !== undefined && overrides.tenant !== undefined) {
        return { apiId: overrides.api, tenantId: overrides.tenant };
    }
    const api = await client.call('serve.api.resolveByHost', { apiHost: hostnameOf(session.apiHost) });
    return {
        apiId: overrides.api ?? api.id,
        tenantId: overrides.tenant ?? api.tenantId,
    };
}
