import { eventPermissions, knownEvents } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import type { ExposeRow } from '../contracts/expose.contract.js';
import { streamableFrom } from './descriptor.js';

/**
 * The rows an api that says `exposeDeclared` serves without a stored row: every public contract the
 * cluster advertises whose own `permissions` gate it, and every streamable event whose definition
 * says who may watch it -- each narrowed by `roles` (the api's `exposeRoles`) to what every required
 * role is one of. The gateway serves these (gateway.ts declaredRows); serve.api.describe lists them
 * too, so a peer reading the contract sees what the api's own /api/_describe shows (10-25: the
 * contract gave 77 of api.surfdns.net's 939 calls, and infer threads saw only those).
 */
export function declaredRowsNow(broker: Pick<IServiceBroker, 'registry' | 'contractDeclaration'>, apiId: string, stored: readonly ExposeRow[], roles?: readonly string[]): ExposeRow[] {
    const named = new Set(stored.filter((row) => row.kind !== 'event').map((row) => row.contract));
    const keys = new Set(broker.registry.getNodes().flatMap((node) => node.services.flatMap((service) => Object.keys(service.tools ?? {}))));
    const allowed = (required: readonly string[]): boolean => roles === undefined || required.every((role) => roles.includes(role));

    const rows: ExposeRow[] = [];
    for (const key of keys) {
        if (named.has(key)) continue;

        const contract = broker.contractDeclaration(key);
        if (contract === undefined || contract.visibility !== 'public' || contract.permissions.length === 0) continue;
        if (!allowed(contract.permissions)) continue;

        rows.push({ apiId, kind: 'contract', contract: key });
    }

    const streamed = new Set(stored.filter((row) => row.kind === 'event').map((row) => row.contract));
    for (const name of knownEvents()) {
        if (streamed.has(name) || !streamableFrom(name)) continue;

        const required = eventPermissions(name);
        if (required === undefined || required.length === 0 || !allowed(required)) continue;

        rows.push({ apiId, kind: 'event', contract: name });
    }

    return rows;
}
