import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPackageRoot } from './corePartPath.js';

/**
 * A node asking its own host to move it to another mesh-serve release -- without SSH.
 *
 * The node runs in a container under systemd, and cannot swap its own image from inside. So it
 * leaves a request where its host can see it: `~/.mesh` is a host directory mounted into the
 * container (/var/lib/mesh on surf, /home/ubuntu/.mesh elsewhere). A systemd path unit on the host
 * (deploy/node-upgrade/install.sh) watches `upgrade/request`, checks it is exactly a release version,
 * pulls `ghcr.io/flybyme/mesh-serve:<version>`, points the unit at it, restarts mesh-node -- rolling
 * back if the new one does not come up -- and writes `upgrade/result.json` for the node to report.
 *
 * What the node writes is a version string and nothing else: the host builds the image name itself,
 * from a fixed registry path, so a request can never name some other image.
 */
export const UPGRADE_DIR = path.join(os.homedir(), '.mesh', 'upgrade');
export const VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,4}$/;

export interface UpgradeResult {
    readonly requested: string;
    readonly from: string;
    readonly status: 'refused' | 'unchanged' | 'failed' | 'restarting' | 'done' | 'rolled-back';
    readonly message: string;
    readonly at: string;
}

let cachedVersion: string | undefined;

/** This process's own release, from mesh-serve's package.json. */
export function runningVersion(): string {
    if (cachedVersion === undefined) {
        const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
        const pkg: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
        cachedVersion = `v${version}`;
    }
    return cachedVersion;
}

export async function writeUpgradeRequest(version: string): Promise<void> {
    if (!VERSION.test(version)) throw new Error(`Not a release version: "${version}" (expected e.g. v0.8.17)`);
    await fs.mkdir(UPGRADE_DIR, { recursive: true });
    // Written in place, not renamed into place: the host's path unit fires on close-after-write.
    await fs.writeFile(path.join(UPGRADE_DIR, 'request'), `${version}\n`);
}

const STATUSES: readonly UpgradeResult['status'][] = ['refused', 'unchanged', 'failed', 'restarting', 'done', 'rolled-back'];
const isStatus = (s: string): s is UpgradeResult['status'] => (STATUSES as readonly string[]).includes(s);

/** What the host last did with a request, if it has done anything -- read as data, checked. */
export async function readUpgradeResult(): Promise<UpgradeResult | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(path.join(UPGRADE_DIR, 'result.json'), 'utf8');
    } catch {
        return undefined;
    }
    try {
        const r: unknown = JSON.parse(raw);
        if (typeof r !== 'object' || r === null) return undefined;
        const get = (k: string): string => (k in r ? String(Reflect.get(r, k)) : '');
        const status = get('status');
        if (!isStatus(status)) return undefined;
        return { requested: get('requested'), from: get('from'), status, message: get('message'), at: get('at') };
    } catch {
        return undefined;
    }
}

/** Whether the host side is installed: it creates the directory and marks it when installed. */
export async function hostAgentInstalled(): Promise<boolean> {
    try {
        await fs.access(path.join(UPGRADE_DIR, 'agent-installed'));
        return true;
    } catch {
        return false;
    }
}
