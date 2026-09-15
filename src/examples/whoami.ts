import { call, createClient, defineApi, fetchTransport, withHeaders, MeshCallError } from '@flybyme/mesh-web/net';

import { issueInputSchema, issueOutputSchema } from '../identity/contracts/ticket.contract.js';
import { whoamiOutputSchema } from '../identity/contracts/identity.contract.js';
import type { z } from 'zod';

/**
 * Proof that the REST api "SDK" is standalone: nothing here is the CLI. A plain script, the same
 * `call`/`defineApi`/`createClient` primitives a browser page or mesh-serve's own CLI use, and real
 * zod imported straight from this package's own contracts (this script ships inside mesh-serve
 * itself, so there's no cross-package version skew to guard against -- an external consumer would get
 * these shapes from a generated file instead, see generateClient.ts in this same directory).
 *
 *   API_HOST=api.localhost API_PORT=5005 \
 *   DEMO_EMAIL=demo@example.com DEMO_PASSWORD=password123 \
 *   npx tsx src/examples/whoami.ts
 */

const apiHost = `${process.env.API_HOST ?? 'api.localhost'}:${process.env.API_PORT ?? '5005'}`;
const email = process.env.DEMO_EMAIL ?? 'demo@example.com';
const password = process.env.DEMO_PASSWORD ?? 'password123';

const whoamiApi = defineApi({
    id: 'whoami-example',
    exposure: 'standalone-script',
    calls: {
        'identity.ticket.issue': call<z.infer<typeof issueInputSchema>, z.infer<typeof issueOutputSchema>>(
            'POST', '/identity/ticket',
        ),
        'identity.whoami': call<void, z.infer<typeof whoamiOutputSchema>>(
            'GET', '/identity/whoami',
        ),
    },
});

async function main(): Promise<void> {
    const origin = apiHost.startsWith('http://') || apiHost.startsWith('https://') ? apiHost : `http://${apiHost}`;

    // No credential yet -- this client only needs one to attach it, not to exist.
    let token: string | undefined;
    const client = createClient(whoamiApi, {
        transport: withHeaders(fetchTransport(origin), (): Record<string, string> => (token === undefined ? {} : { Authorization: `Bearer ${token}` })),
        checkExposure: false,
    });

    const ticket = await client.call('identity.ticket.issue', { email, password });
    token = ticket.token;
    console.log(`logged in as ${ticket.userId}`);

    const who = await client.call('identity.whoami');
    console.log('whoami:', who);
}

main().catch((err) => {
    console.error(err instanceof MeshCallError ? err.message : (err instanceof Error ? err.message : err));
    process.exitCode = 1;
});
