/**
 * A `register(broker)`-shaped part that mounts one collection and then throws: what the merged
 * surfdns-workflows part did on 10-24, its second area refused ("already mounted") after its first
 * was up. For proving a load that fails part way takes back what it mounted.
 */
import { defineCrud, z } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

export const HalfSchema = z.object({
    tenantId: z.string(),
    name: z.string(),
});

export const halfCrud = defineCrud('registerShapeHalf', HalfSchema, {
    dependencies: [],
    scopedBy: 'tenantId',
    filePath: 'test/fixtures/register-shape/half.ts',
    permissions: [],
});

export async function register(broker: IServiceBroker): Promise<string> {
    broker.registerCrud(halfCrud);
    throw new Error('the second area could not be mounted');
}

export default register;
