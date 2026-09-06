/**
 * An edge: a running CDN node, reachable by peers for blob retrieval.
 *
 * M2: "One row per running edge: id and url."
 *
 * ## What is here, and what is deliberately not
 *
 * - `url`: Where a peer can fetch blobs over HTTP. The one value the mesh does not know.
 * - `id`: Handled by `defineCrud` / the database layer as the primary document key.
 *
 * Not liveness: no `lastSeen`, no `healthy`, no `status`, no heartbeat, no timeout sweeper.
 * The mesh already tracks connected nodes via `RegistryModule`. A second heartbeat beside it
 * produces two sources of truth that disagree during partitions — the exact incident where
 * it matters.
 *
 * An edge that dies without removing its row is the ordinary case, not an error: C5 discovers
 * reachability by attempting to fetch and failing, which is one source of truth rather than two.
 */

import { z } from '@flybyme/mesh';

export const EdgeSchema = z.object({
    /**
     * The base URL where this edge serves HTTP requests (including blob fetches for peers).
     *
     * Stored as a URL string (e.g. `http://127.0.0.1:8080` or `http://edge-1.internal:8080`).
     */
    url: z.string().min(1),
}).strict();
