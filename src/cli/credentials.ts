/**
 * Where a ticket is kept between commands.
 *
 * **A ticket, never a password.** The password is typed, exchanged, and forgotten; what persists is
 * a credential the server can withdraw, which is the whole reason a ticket is a row
 * (`spec/identity.md` §9).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Per host, because **a ticket is for one host** and using one against another is a wrong answer. */
export interface Stored {
    readonly ticket: string;
    readonly userId: string;
    readonly expiresAt: number;
}

type Store = Record<string, Stored>;

export const credentialsPath = (): string =>
    process.env['MESH_SERVE_CREDENTIALS'] ?? join(homedir(), '.config', 'mesh-serve', 'credentials.json');

function readStore(path: string): Store {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {};
    } catch {
        // Missing, unreadable or corrupt all mean the same thing to a caller: you are not signed in.
        return {};
    }
}

export function ticketFor(host: string): Stored | undefined {
    const stored = readStore(credentialsPath())[host];
    if (stored === undefined) return undefined;

    // An expired ticket is not a ticket. Returning it would send the caller to a 401 they cannot act
    // on, when the honest answer is that they need to sign in again.
    return stored.expiresAt > Date.now() ? stored : undefined;
}

/**
 * Write a ticket, readable by nobody else.
 *
 * `0o600` on the file and `0o700` on the directory, set explicitly rather than left to the umask —
 * a credential written world-readable on a shared machine is a credential that has been shared.
 */
export function saveTicket(host: string, stored: Stored): string {
    const path = credentialsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const store = readStore(path);
    store[host] = stored;

    writeFileSync(path, `${JSON.stringify(store, null, 4)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);

    return path;
}

export function forgetTicket(host: string): void {
    const path = credentialsPath();
    const store = readStore(path);
    if (store[host] === undefined) return;

    delete store[host];
    writeFileSync(path, `${JSON.stringify(store, null, 4)}\n`, { mode: 0o600 });
}
