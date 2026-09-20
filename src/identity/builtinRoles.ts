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
 * The seeding itself is `identity.role.ensureBuiltins` (`tools/ensureBuiltins.ts`) -- a real
 * contract, because it writes shared cluster state and so belongs to bootstrap's one deliberate
 * pass rather than to every node that happens to load the identity part. This wrapper is for
 * callers that hold a broker rather than a handler's ctx.
 */
export async function ensureBuiltinRoles(broker: IServiceBroker): Promise<void> {
    await broker.call('identity.role.ensureBuiltins', {});
}
