import { everyTenant, type IServiceContext, type z } from '@flybyme/mesh';

import { type holdAllContract, maskHold } from '../contracts/hold.contract.js';

/**
 * serve.hold.all -- operator only: every organization's holds, newest first.
 * The collection is tenant-scoped, so standard reads see only the caller's organization.
 */
export async function all(
    input: z.infer<typeof holdAllContract.inputSchema>,
    ctx: IServiceContext,
): Promise<z.infer<typeof holdAllContract.outputSchema>> {
    const query = input.status !== undefined ? { status: input.status } : {};
    const limit = input.limit ?? 200;

    const rows = await everyTenant(ctx, 'serve.hold').find({
        query,
        sort: '-requestedAt',
        limit,
    });

    return rows.map(maskHold);
}
