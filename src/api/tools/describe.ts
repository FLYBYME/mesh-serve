/**
 * `api.describe` — what a hostname exposes, with its real gates.
 *
 * The same join the request path makes, answered as data instead of routed: `site.mesh` supplies the
 * keys and gates, the contract registry supplies methods, paths and schemas, and the api is the only
 * place both halves are in hand.
 */

import { ClientError, globalContractRegistry, z, type IServiceContext } from '@flybyme/mesh';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ApiService } from '../api.service.js';
import { BASE_PATH } from '../api.service.js';
import { canonical, digestOf } from '../../builder/methods/content.js';
import { normalizeHostname } from '../../cdn/methods/hostname.js';
import type { Release } from '../../cdn/contracts/release.contract.js';
import type { Site } from '../../cdn/contracts/site.contract.js';
import { describeContract } from '../contracts/api.contract.js';
import { routeTable, type ContractLookup } from '../methods/routes.js';

type Input = z.infer<typeof describeContract['inputSchema']>;
type Output = z.infer<typeof describeContract['outputSchema']>;

export async function api_describe(
    this: ApiService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const host = normalizeHostname(input.host);

    const site = await ctx.call('cdn.resolve_site', { host })
        .catch(() => {
            throw new ClientError(`No site is configured for ${host}.`, 'site_not_found', 404);
        });

    let release: Release | undefined;
    if (site.releaseHash !== undefined) {
        const found = await ctx.call('release.find_one', { query: { hash: site.releaseHash } })
            .catch(() => null);
        if (found !== null && found !== undefined) release = found;
    }

    const lookup: ContractLookup = (key) => globalContractRegistry.get(key);

    const table = routeTable(site.mesh, lookup, (value) => digestOf(canonical(value)), release?.requires);

    return {
        host,
        base: BASE_PATH,
        exposure: table.exposure,
        calls: table.routes.map((route) => ({
            key: route.key,
            method: route.method,
            path: route.path,
            description: route.contract.description,
            gate: route.gate.kind === 'auth' ? route.gate.level : `permission:${route.gate.permission}`,
            destructive: route.contract.destructive === true,
            // **Structural JSON Schema, never a `z.infer` across a package boundary.** A generated
            // client that referenced a schema in another package broke on a zod version bump; a
            // client that states its own shapes cannot.
            input: zodToJsonSchema(route.contract.inputSchema),
            output: zodToJsonSchema(route.contract.outputSchema),
        })),
        unknown: [...table.unknown],
    };
}
