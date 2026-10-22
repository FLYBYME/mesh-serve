import { resolveCallerTenant } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import type { HoldAllowInput, HoldAllowOutput } from '../contracts/hold.contract.js';

/**
 * serve.hold.allow -- the caller's organization's standing approval of one call: allowed, its api
 * tokens' calls to it run at once; not, they are held again. The organization is the call's, never
 * an input. The gateway reads these rules (gateway.ts, the hold branch).
 */
export async function allow(input: HoldAllowInput, ctx: IServiceContext): Promise<HoldAllowOutput> {
    const tenantId = resolveCallerTenant(ctx);
    const rules = ctx.db('serve.holdRule');

    const existing = await rules.findOne({ query: { call: input.call } });

    if (input.allowed && existing === undefined) {
        await rules.create({ tenantId, call: input.call, setBy: ctx.meta?.user?.id ?? '', setAt: new Date() });
    }

    if (!input.allowed && existing !== undefined) {
        await rules.delete({ id: existing.id });
    }

    ctx.logger.info(`[hold] ${tenantId}: ${input.call} ${input.allowed ? 'runs at once for its tokens' : 'held again'}, by ${ctx.meta?.user?.id ?? 'unknown'}`);

    return { call: input.call, allowed: input.allowed };
}
