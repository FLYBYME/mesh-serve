import type { Session } from './session.js';
import { persistSession } from './session.js';
import type { Client } from './client.js';
import type { ExposureDescriptor } from './describe.js';

/**
 * Returns the cached descriptor when there is one for the current host -- fetching /api/_describe
 * on every single invocation is exactly what a persisted session exists to avoid. "refresh" (or
 * "switch", which clears the cache) is the explicit way to force a real fetch.
 */
export async function ensureDescriptor(session: Session, client: Client): Promise<ExposureDescriptor> {
    if (session.descriptor !== undefined) {
        return session.descriptor;
    }
    session.descriptor = await client.describe(session.apiHost);
    await persistSession(session);
    return session.descriptor;
}
