import { createClient, fetchTransport, withHeaders, type MeshClient } from '@flybyme/mesh-web/net';

import { cliApi } from './api.js';
import type { Session } from './session.js';

export function originOf(apiHost: string): string {
    return apiHost.startsWith('http://') || apiHost.startsWith('https://') ? apiHost : `http://${apiHost}`;
}

/**
 * `session.apiHost` carries a port for the transport (`switch api.localhost:5005`); `serve.api`'s own
 * `apiHost` field never does (`BOOTSTRAP_API_HOST` is the bare hostname `resolveByHost` matches
 * against). The inverse of `originOf` -- that one adds a scheme for `fetch`, this one strips
 * everything `serve.api` doesn't store.
 */
export function hostnameOf(apiHost: string): string {
    return apiHost.replace(/^https?:\/\//, '').split(':')[0] ?? apiHost;
}

/**
 * `switch`'s whole job: the origin is a runtime argument to the transport, not baked into the typed
 * surface, so one typed client can point at whichever host the session currently selects. Exposure
 * checking is off -- this client isn't a generated one guarding against a site's exposure moving out
 * from under it, it's the CLI's own always-on baseline, hand-declared alongside the server it ships
 * with.
 */
export function buildClient(session: Session): MeshClient<typeof cliApi> {
    const transport = withHeaders(fetchTransport(originOf(session.apiHost)), (): Record<string, string> =>
        session.credential !== undefined ? { Authorization: `Bearer ${session.credential}` } : {});
    return createClient(cliApi, { transport, checkExposure: false });
}
