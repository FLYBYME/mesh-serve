import type { IServiceBroker, z } from '@flybyme/mesh';

import type { roleCrud } from './contracts/role.contract.js';

type RoleType = z.infer<typeof roleCrud.baseSchema>;

/**
 * The one place these are defined. Used to be two separate, disagreeing copies -- sync.ts's own
 * `Roles` array (whose 'operator' permissions were the literal string `'**'`, which
 * `matchesContract` never actually matches -- it only recognizes an exact contract name or a real
 * `"<prefix>.*"` suffix, so that copy was a silently powerless role definition) and
 * identity.service.ts's onStart, hand-rolled inline with a *different*, correct permission set.
 * Harmless only by accident of boot ordering: onStart always ran first and seeded the working
 * version before sync.ts's broken one ever got a chance to.
 */
export const BuiltinRoles: readonly RoleType[] = [
    { key: 'operator', name: 'Operator', scope: 'global', builtin: true, inherits: [], permissions: ['identity.*', 'serve.*'] },
    { key: 'owner', name: 'Owner', scope: 'organization', builtin: true, inherits: [], permissions: [] },
    { key: 'admin', name: 'Admin', scope: 'organization', builtin: true, inherits: [], permissions: [] },
    { key: 'member', name: 'Member', scope: 'organization', builtin: true, inherits: [], permissions: [] },
];

/**
 * Create-if-missing, not upsert: an existing row is left exactly as it is, including any
 * customization an operator already made to it (identity.role.upsert is the explicit, deliberate
 * way to change a builtin role's permissions after the fact -- this only ever fills a genuine gap,
 * the same "explicit, not automatic" rule the rest of this session's cleanup already applied to
 * HOLD_EXPOSED_CONTRACTS).
 */
export async function ensureBuiltinRoles(broker: IServiceBroker): Promise<void> {
    for (const role of BuiltinRoles) {
        const found = await broker.call('identity.role.find_one', { query: { key: role.key, scope: role.scope } });
        if (found) continue;
        await broker.call('identity.role.create', role);
        broker.logger.info(`No "${role.key}" role found, created one.`);
    }
}
