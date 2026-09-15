import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface StoredSession {
    readonly apiHost: string;
    readonly credential?: string;
}

const storePath = path.join(os.homedir(), '.mesh-serve', 'session.json');

export async function loadStore(): Promise<StoredSession | undefined> {
    try {
        const raw = await fs.readFile(storePath, 'utf-8');
        return JSON.parse(raw) as StoredSession;
    } catch {
        return undefined;
    }
}

export async function saveStore(session: StoredSession): Promise<void> {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(session, null, 2));
}
