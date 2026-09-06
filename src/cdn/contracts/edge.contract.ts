/**
 * What the cdn owns: the registry of running edges.
 *
 * One row per running edge: `id` and `url`.
 *
 * ## Scoping and visibility
 *
 * An edge is platform infrastructure, not a tenant's. Scoping this to a tenant would be
 * meaningless — artifacts are content-addressed and shared across tenants, and an edge serves
 * any site routed to it. So this collection is global and unscoped.
 *
 * Nothing outside the platform has any use for a list of internal CDN servers, so all CRUD
 * actions are internal and not exposed.
 *
 * ## Why no liveness or heartbeat
 *
 * The mesh already knows which nodes are up. A second heartbeat beside it would create two
 * sources of truth that disagree during partitions. Self-registration on start and removal on
 * clean shutdown is the whole lifecycle; an edge that dies without removing its row is found
 * by C5 trying to fetch from `url` and failing.
 */

import { defineCrud, z } from '@flybyme/mesh';

import { EdgeSchema } from '../schema/edge.js';

export const edgeCrud = defineCrud('edge', EdgeSchema, {
    pluralPath: 'edges',

    // Reading and writing an edge record touches no other domain.
    dependencies: [],
});

/** An edge as stored. */
export type Edge = z.infer<typeof edgeCrud.outputSchema>;
