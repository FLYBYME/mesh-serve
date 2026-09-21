/**
 * A minimal `register(broker)`-shaped part, for proving `loadAndRegisterModule` can restart one
 * cleanly -- see loadModule.ts's `before`/`after` `listContracts()` diff. Deliberately unbundled
 * (no esbuild step): `loadAndRegisterModule` just `import()`s whatever `absolutePath` names, and a
 * real file on disk exercises the same code path a built artifact would, with none of the build
 * machinery a test doesn't need.
 */
import { defineCrud, z } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

export const WidgetSchema = z.object({
    tenantId: z.string(),
    name: z.string(),
});

export const widgetCrud = defineCrud('registerShapeWidget', WidgetSchema, {
    dependencies: [],
    scopedBy: 'tenantId',
    filePath: 'test/fixtures/register-shape/widget.ts',
    permissions: [],
});

export async function register(broker: IServiceBroker): Promise<string> {
    broker.registerCrud(widgetCrud);
    return 'registerShapeWidget';
}

export default register;
