import { everyTenant, type IServiceContext, type z } from '@flybyme/mesh';

import type { holdRemoveContract } from '../contracts/hold.contract.js';

/**
 * serve.hold.remove -- operator only: decided holds, by exact id, from every organization (the
 * collection is tenant-scoped; an operator removes a customer's too). A hold still `held` stays.
 */
export async function remove(
    input: z.infer<typeof holdRemoveContract.inputSchema>,
    ctx: IServiceContext,
): Promise<z.infer<typeof holdRemoveContract.outputSchema>> {
    const holds = everyTenant(ctx, 'serve.hold');
    const removed: string[] = [];
    const refused: { id: string; why: string }[] = [];

    for (const id of input.ids) {
        const row = await holds.findOne({ id });

        if (row === null || row === undefined) {
            refused.push({ id, why: 'not found' });
            continue;
        }

        if (row.status === 'held') {
            refused.push({ id, why: 'still held: decide it first' });
            continue;
        }

        await holds.delete(id);
        removed.push(id);
    }

    return { removed, refused };
}
