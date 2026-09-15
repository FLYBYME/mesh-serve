import { loadStore, saveStore } from './store.js';

export interface Session {
    apiHost: string;
    credential?: string;
}

export async function createSession(apiHostOverride?: string): Promise<Session> {
    const stored = await loadStore();
    const apiHost = apiHostOverride ?? stored?.apiHost ?? 'localhost:5005';
    return {
        apiHost,
        credential: stored?.apiHost === apiHost ? stored.credential : undefined,
    };
}

export async function persistSession(session: Session): Promise<void> {
    await saveStore(session);
}
