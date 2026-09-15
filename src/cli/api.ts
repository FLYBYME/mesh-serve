import type { z } from 'zod';
import { call, defineApi } from '@flybyme/mesh-web/net';

import { issueInputSchema, issueOutputSchema } from '../identity/contracts/ticket.contract.js';
import { whoamiOutputSchema } from '../identity/contracts/identity.contract.js';
import { generateClientInputSchema, generateClientOutputSchema } from '../api/contracts/generateClient.contract.js';

/**
 * The CLI's own baseline surface -- the handful of contracts always exposed on DEFAULT_API_HOST,
 * tied to no site (see api.service.ts's ALWAYS_EXPOSED). Declared directly against this package's
 * own contract schemas rather than generated: the CLI ships inside mesh-serve itself, always at the
 * same version as the server it's built to talk to, so there is no cross-package version skew for a
 * generated file to guard against (unlike a real generated client, which talks to a host that may be
 * running different code entirely). Still the same `call`/`defineApi` mechanism every other consumer
 * uses, not a bespoke fetch layer.
 */
export const cliApi = defineApi({
    id: 'mesh-serve-cli',
    exposure: 'cli',
    calls: {
        'identity.ticket.issue': call<z.infer<typeof issueInputSchema>, z.infer<typeof issueOutputSchema>>(
            'POST', '/identity/ticket',
        ),
        'identity.whoami': call<void, z.infer<typeof whoamiOutputSchema>>(
            'GET', '/identity/whoami',
        ),
        'serve.api.generateClient': call<z.infer<typeof generateClientInputSchema>, z.infer<typeof generateClientOutputSchema>>(
            'POST', '/generate-client',
        ),
    },
});
