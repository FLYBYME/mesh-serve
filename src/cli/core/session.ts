import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DescribedCall, ExposureDescriptor } from '../../api/methods/descriptor.js';

/** What the session keeps of an api's `_describe`: its surface, and when it was read. */
export function toCachedDescriptor(descriptor: ExposureDescriptor): CachedDescriptor {
    return {
        host: descriptor.host,
        base: descriptor.base,
        shapeHash: descriptor.shapeHash,
        exposure: descriptor.exposure,
        calls: descriptor.calls,
        fetchedAt: Date.now(),
    };
}

/**
 * The CLI's own state: which api it is pointed at, and the ticket it holds.
 *
 * One ticket, many apis -- deliberately. A ticket carries no api and no tenant
 * (`identity/schema/ticket.ts` is `{ token, userId, roles, issuedAt, expiresAt, via }`), so it
 * validates against whichever api the request reaches. Authentication is global; authorization is
 * per-api (its own `serve.expose` rows) and per-organization (`identity.hasRole` against that api's
 * `tenantId`). So `switch` changes what you can *say*, never who you are, and never asks you to log
 * in again.
 */
export interface CachedDescriptor {
    readonly host: string;
    readonly base: string;
    readonly shapeHash: string;
    readonly exposure: string;
    readonly calls: readonly DescribedCall[];
    /** ms since epoch, so `switch` can report how old the cached surface is. */
    readonly fetchedAt: number;
}

export interface Session {
    /** Origin of the api this CLI currently speaks to, e.g. "http://api.localhost:3223". */
    readonly apiUrl?: string;
    readonly token?: string;
    readonly userId?: string;
    readonly email?: string;
    /** ms since epoch. */
    readonly expiresAt?: number;
    /** The current api's surface, cached so `--help` works without a round trip (or a cluster). */
    readonly descriptor?: CachedDescriptor;
}

const SESSION_DIR = path.join(os.homedir(), '.mesh-serve');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

export function sessionPath(): string {
    return SESSION_FILE;
}

/**
 * Missing, unreadable and malformed all mean the same thing -- no session yet. A CLI that refuses
 * to start because its own cache is corrupt is worse than one that re-logs-in.
 */
export async function readSession(): Promise<Session> {
    try {
        const raw = await fs.readFile(SESSION_FILE, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return {};
        return parsed as Session;
    } catch {
        return {};
    }
}

/** 0700 on the directory and 0600 on the file: this holds a bearer token in plain text. */
export async function writeSession(session: Session): Promise<void> {
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    // mkdir/writeFile only apply `mode` when they *create*; an existing file keeps whatever it had,
    // including a group-readable mode from before this was tightened.
    await fs.chmod(SESSION_FILE, 0o600);
}

export async function patchSession(patch: Partial<Session>): Promise<Session> {
    const next = { ...(await readSession()), ...patch };
    await writeSession(next);
    return next;
}

/** Whether the stored ticket is usable right now. Absent `expiresAt` is treated as valid. */
export function isLive(session: Session): boolean {
    if (session.token === undefined) return false;
    if (session.expiresAt === undefined) return true;
    return session.expiresAt > Date.now();
}
