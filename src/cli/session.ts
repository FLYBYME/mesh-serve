import type { ExposureDescriptor } from './describe.js';
import { loadStore, saveStore } from './store.js';

export interface Session {
    apiHost: string;
    credential?: string;
    descriptor?: ExposureDescriptor;
}

/**
 * Loads the persisted session, falling back to a fresh one. A cached descriptor is only reused when
 * the requested host matches what it was fetched for -- otherwise it's stripped so the caller knows
 * to fetch a real one before doing anything, rather than silently running the wrong host's commands.
 */
export async function createSession(apiHostOverride?: string): Promise<Session> {
    const stored = await loadStore();
    const apiHost = apiHostOverride ?? stored?.apiHost ?? 'localhost:5005';

    return {
        apiHost,
        credential: stored?.apiHost === apiHost ? stored.credential : undefined,
        descriptor: stored?.apiHost === apiHost ? stored.descriptor : undefined,
    };
}

export async function persistSession(session: Session): Promise<void> {
    await saveStore(session);
}
