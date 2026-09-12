import assert from 'assert/strict';
import type { SupervisorTestContext } from '../../../src/supervisor/Supervisor.js';

export const tests: Record<string, (ctx: SupervisorTestContext) => Promise<void>> = {
    'create and find round-trip': async (ctx) => {
        const created = (await ctx.broker.call(`${ctx.mountKey}.create` as never, { name: 'widget-a' } as never)) as unknown as { id: string; name: string };
        assert.equal(created.name, 'widget-a');

        const found = (await ctx.broker.call(`${ctx.mountKey}.get` as never, { id: created.id } as never)) as unknown as { name: string };
        assert.equal(found.name, 'widget-a');
    },

    'deliberately fails, to prove failures are reported and don\'t abort the run': async () => {
        assert.equal(1 + 1, 3, 'intentional failure fixture');
    },
};
