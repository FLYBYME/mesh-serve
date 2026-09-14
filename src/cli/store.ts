import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { ExposureDescriptor } from './describe.js';

/**
 * Persisted across separate `mesh-serve` invocations, not just within one REPL -- login and switch
 * would be useless in one-shot mode otherwise, since each invocation is a fresh process with no
 * memory of the last one. The cached descriptor is what lets a one-shot call skip re-fetching
 * /api/_describe every single time; `refresh` (or switching host) is what invalidates it.
 */
export interface StoredSession {
    readonly apiHost: string;
    readonly credential?: string;
    readonly descriptor?: ExposureDescriptor;
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
