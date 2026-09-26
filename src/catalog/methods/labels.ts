import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A node's labels as set through the api (serve.node.label), kept where the node keeps its state
 * (~/.mesh, a host directory) so they survive a restart and an upgrade. `mesh-serve start --labels`
 * gives the labels a machine boots with; what is saved here is laid over them, key by key -- a
 * role assigned through the api is not undone by the unit file's flags on the next restart.
 */
export const LABELS_FILE = path.join(os.homedir(), '.mesh', 'labels.json');

const KEY = /^[A-Za-z0-9._-]{1,63}$/;
const VALUE = /^[A-Za-z0-9._,=-]{0,200}$/;

export function validLabel(key: string, value: string): boolean {
    return KEY.test(key) && VALUE.test(value);
}

/** What was saved, if anything -- read at start, synchronously, before the node joins. */
export function readSavedLabels(): Record<string, string> {
    let raw: string;
    try {
        raw = readFileSync(LABELS_FILE, 'utf8');
    } catch {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && validLabel(k, v)) out[k] = v;
        return out;
    } catch {
        return {};
    }
}

export async function saveLabels(labels: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(LABELS_FILE), { recursive: true });
    const tmp = `${LABELS_FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(labels, null, 2)}\n`);
    await fs.rename(tmp, LABELS_FILE);
}
