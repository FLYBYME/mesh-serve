/**
 * Telemetry contracts:
 * - `telem.ingest`: public ingest endpoint for browser batches
 * - `telem.query`: internal / operator query endpoint
 */

import { defineContract } from '@flybyme/mesh';
import {
    TelemIngestInputSchema,
    TelemIngestOutputSchema,
    TelemQueryInputSchema,
    TelemQueryOutputSchema,
} from '../schema/telem.js';

/**
 * Public ingest contract for batched events from browser sessions.
 *
 * Anonymous callers are allowed (a page that has not signed in still boots
 * and fails, and that is precisely when logs matter). Writes are bounded by
 * batch size (max 100), payload limits, and rate limiting.
 */
export const ingestContract = defineContract({
    domain: 'telem',
    action: 'ingest',
    description: 'Ingest a batch of telemetry events from a browser session.',
    inputSchema: TelemIngestInputSchema,
    outputSchema: TelemIngestOutputSchema,
    rest: { method: 'POST', path: '/telem/ingest' },
    visibility: 'public',
    print: (o) => `accepted ${o.accepted}, dropped ${o.dropped}`,
});

/**
 * Query contract for inspecting telemetry by session, site, level, and time.
 */
export const queryContract = defineContract({
    domain: 'telem',
    action: 'query',
    description: 'Query stored telemetry events by session, site, level, or time range.',
    inputSchema: TelemQueryInputSchema,
    outputSchema: TelemQueryOutputSchema,
    rest: { method: 'POST', path: '/telem/query' },
    visibility: 'internal',
    print: (o) => `${o.total} event(s)`,
});
