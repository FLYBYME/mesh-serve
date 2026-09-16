import type { z } from 'zod';
import { call, defineApi } from '@flybyme/mesh-web/net';

import { issueInputSchema, issueOutputSchema } from '../identity/contracts/ticket.contract.js';
import { whoamiOutputSchema } from '../identity/contracts/identity.contract.js';
import { setPasswordInputSchema, setPasswordOutputSchema } from '../identity/contracts/user.contract.js';
import { organizationCrud } from '../identity/contracts/organization.contract.js';
import { generateClientInputSchema, generateClientOutputSchema } from '../api/contracts/generateClient.contract.js';
import { addInputSchema, addOutputSchema } from '../api/contracts/expose.contract.js';
import { resolveApiByHostInputSchema, resolveApiByHostOutputSchema } from '../api/contracts/api.contract.js';
import { repoCrud } from '../catalog/contracts/repo.contract.js';
import { partCrud } from '../catalog/contracts/part.contract.js';
import { artifactCrud, requestBuildInputSchema, requestBuildOutputSchema } from '../catalog/contracts/artifact.contract.js';
import { composeInputSchema, composeOutputSchema, compositionCrud } from '../catalog/contracts/composition.contract.js';
import { getReleaseInputSchema, getReleaseOutputSchema } from '../catalog/contracts/release.contract.js';
import { siteCrud, deployInputSchema, deployOutputSchema, resolveHostInputSchema, resolveHostOutputSchema } from '../cdn/contracts/site.contract.js';

/**
 * A create input's `scopedBy` field (`tenantId`, always) is optional at the actual, validated schema
 * -- ApiService fills it in from the target api's own tenant, or an operator's override, before
 * parsing -- but `defineCrud`'s exported `CreateIn<>` type still marks it required (a real gap
 * between the runtime schema and its own type, unrelated to this CLI). Widened back to optional here
 * rather than upstream: mesh is frozen, and every caller of these four creates needs the same fix.
 */
type Scoped<T> = Omit<T, 'tenantId'> & { readonly tenantId?: string };

/**
 * The CLI's own baseline surface. `identity.*`/`serve.api.resolveByHost` are always exposed on
 * DEFAULT_API_HOST (see api.service.ts's BOOTSTRAP_EXPOSED_CONTRACTS); the `serve.repo`/`part`/
 * `artifact`/`composition`/`cdn` calls below are not -- `init`/`publish` expose themselves on
 * whatever api they're pointed at (via `serve.expose.add`, which is itself bootstrap-exposed) before
 * using them, the same self-heal `composeConsole.ts`'s demo script does by hand.
 *
 * Declared directly against this package's own contract schemas rather than generated: the CLI ships
 * inside mesh-serve itself, always at the same version as the server it's built to talk to, so there
 * is no cross-package version skew for a generated file to guard against (unlike a real generated
 * client, which talks to a host that may be running different code entirely). Still the same
 * `call`/`defineApi` mechanism every other consumer uses, not a bespoke fetch layer.
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
        'identity.user.setPassword': call<z.infer<typeof setPasswordInputSchema>, z.infer<typeof setPasswordOutputSchema>>(
            'POST', '/identity/password',
        ),
        'serve.api.resolveByHost': call<z.infer<typeof resolveApiByHostInputSchema>, z.infer<typeof resolveApiByHostOutputSchema>>(
            'GET', '/apis/host/:apiHost',
        ),
        'identity.organization.get': call<z.infer<typeof organizationCrud.get.inputSchema>, z.infer<typeof organizationCrud.get.outputSchema>>(
            'GET', '/organizations/:id',
        ),
        'serve.api.generateClient': call<z.infer<typeof generateClientInputSchema>, z.infer<typeof generateClientOutputSchema>>(
            'POST', '/generate-client',
        ),
        'serve.expose.add': call<z.infer<typeof addInputSchema>, z.infer<typeof addOutputSchema>>(
            'POST', '/expose',
        ),
        'serve.repo.create': call<Scoped<z.infer<typeof repoCrud.create.inputSchema>>, z.infer<typeof repoCrud.create.outputSchema>>(
            'POST', '/repos',
        ),
        'serve.part.create': call<Scoped<z.infer<typeof partCrud.create.inputSchema>>, z.infer<typeof partCrud.create.outputSchema>>(
            'POST', '/parts',
        ),
        'serve.part.find_one': call<{ query: Record<string, unknown> }, z.infer<typeof partCrud.findOne.outputSchema>>(
            'GET', '/parts/one',
        ),
        'serve.artifact.requestBuild': call<z.infer<typeof requestBuildInputSchema>, z.infer<typeof requestBuildOutputSchema>>(
            'POST', '/artifacts/requestBuild',
        ),
        'serve.artifact.find': call<{ query: Record<string, unknown> }, z.infer<typeof artifactCrud.find.outputSchema>>(
            'GET', '/artifacts',
        ),
        'serve.composition.create': call<Scoped<z.infer<typeof compositionCrud.create.inputSchema>>, z.infer<typeof compositionCrud.create.outputSchema>>(
            'POST', '/compositions',
        ),
        'serve.composition.compose': call<z.infer<typeof composeInputSchema>, z.infer<typeof composeOutputSchema>>(
            'POST', '/compositions/:id/compose',
        ),
        'serve.release.getRelease': call<z.infer<typeof getReleaseInputSchema>, z.infer<typeof getReleaseOutputSchema>>(
            'GET', '/releases/:hash',
        ),
        'serve.cdn.create': call<Scoped<z.infer<typeof siteCrud.create.inputSchema>>, z.infer<typeof siteCrud.create.outputSchema>>(
            'POST', '/sites',
        ),
        'serve.cdn.deploy': call<z.infer<typeof deployInputSchema>, z.infer<typeof deployOutputSchema>>(
            'POST', '/sites/:siteId/deploy',
        ),
        'serve.cdn.resolveHost': call<z.infer<typeof resolveHostInputSchema>, z.infer<typeof resolveHostOutputSchema>>(
            'GET', '/sites/:host',
        ),
    },
});
