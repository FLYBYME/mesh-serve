/**
 * The `site` service: what a hostname resolves to.
 *
 * **No listener.** It answers mesh calls; the projections in `./api/` bind the ports. Keeping the
 * record and the listener apart is what lets a second protocol be added without touching this.
 */

import {
    ServiceModule, type ServiceActionHandler, type ToolContract, type z,
} from '@flybyme/mesh';

import { resolveSiteContract, siteCrud } from './contracts/site.contract.js';
import { normalizeHostname } from './methods/hostname.js';

export class ServeService extends ServiceModule {
    public readonly domain = 'site';

    constructor() {
        super();

        this.mountCrud(siteCrud);
        this.mountTool(resolveSiteContract, this.resolveHost);
    }

    /**
     * One site, by hostname.
     *
     * **Normalised here as well as by the caller**, and that is not redundancy for its own sake:
     * this is the lookup, so it owns the spelling rule. A projection that forgot to normalise would
     * otherwise produce a 404 that comes and goes with how a link was typed, and the bug would live
     * in the projection rather than here.
     *
     * **Unscoped, deliberately and necessarily.** Resolving a site is what *produces* the scope, so
     * it cannot run inside one — which is why `site` is a public collection with an owner field
     * rather than a `scopedBy` one. It is safe because it is narrowed to a single exact hostname,
     * which is stricter than a scope would have been: a caller cannot enumerate with it.
     */
    private readonly resolveHost: ServiceHandler<typeof resolveSiteContract> = async (input, ctx) => {
        const host = normalizeHostname(input.host);
        if (host === '') return undefined;

        const found = await ctx.call('site.find', { query: { host }, limit: 1 });
        return found[0];
    };
}

type ServiceHandler<C extends ToolContract<z.ZodTypeAny, z.ZodTypeAny>> =
    ServiceActionHandler<z.infer<C['inputSchema']>, z.infer<C['outputSchema']>>;
